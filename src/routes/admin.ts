import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { config, isProd, isServerless } from '../config.js';
import { redis, keys } from '../redis.js';
import { newId, randomToken, safeCompareHex, sha256 } from '../util.js';
import { audit } from '../audit.js';
import {
  bumpAclVersion,
  checkPermission,
  FORBIDDEN_SCOPE_KEYS,
  resolveForApp,
  SAFE_DEFAULT_SCOPE_FIELDS,
  type EffectiveAccess,
} from '../acl/engine.js';
import { verifyJwt } from '../tokens/jwt.js';
import {
  getUser,
  sanitizeUser,
  publishAclVersion,
  academicOf,
  issueAccessToken,
  denyJti,
  denyUserTokens,
  clearUserDeny,
} from '../tokens/access.js';
import { revokeAllForUser, revokeRefresh, rotateRefresh } from '../tokens/refresh.js';
import { getQueue } from '../jobs/queue.js';
import { createJobRecord, listJobs, getJobRecord } from '../jobs/tracker.js';
import { importUsersCsv, roleExpirySweep, semesterRollover } from '../jobs/handlers.js';
import { exportUsersCsv } from '../jobs/export.js';

declare module 'fastify' {
  interface FastifyRequest {
    admin?: { userId: string; access: EffectiveAccess; jti?: string; exp?: number };
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const ALLOWED_USER_UPDATE_COLUMNS = new Set([
  'name',
  'status',
  'dept',
  'branch',
  'degree',
  'roll_no',
  'twelve_digit_roll_no',
  'year',
  'semester',
  'section',
  'group_no',
  'batch_no',
  'batch_year',
  'employee_id',
  'designation',
  'mobile_no',
]);

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

/** Verify CSRF headers for state-changing requests authenticated via browser cookies. */
function enforceCookieCsrf(req: FastifyRequest) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    throw new HttpError(403, 'CSRF check failed: cross-site request blocked');
  }
  const origin = req.headers.origin;
  if (origin && !config.corsOrigins.includes(origin)) {
    throw new HttpError(403, 'CSRF check failed: untrusted Origin');
  }
  const xrw = req.headers['x-requested-with'];
  if (!xrw && (!origin || !config.corsOrigins.includes(origin))) {
    throw new HttpError(403, 'CSRF check failed: missing X-Requested-With or trusted Origin header');
  }
}

/** Authenticate with either BFF session cookie or Authorization Bearer header. */
async function adminAuth(req: FastifyRequest) {
  const cookieToken = req.cookies.acl_admin_session;
  const h = req.headers.authorization;
  const bearerToken = h?.startsWith('Bearer ') ? h.slice(7) : null;
  const raw = bearerToken ?? cookieToken;
  if (!raw) throw new HttpError(401, 'missing authentication credentials');

  // When authenticated via browser cookie (and not Bearer token), enforce CSRF protection on mutating methods
  if (!bearerToken && cookieToken) {
    enforceCookieCsrf(req);
  }

  let claims;
  try {
    claims = await verifyJwt(raw, config.internalAppId);
  } catch {
    throw new HttpError(401, 'invalid or expired session token');
  }
  if (claims.token_use === 'id') {
    throw new HttpError(401, 'id_token cannot be used as an access token');
  }
  const [jtiDenied, userDenied] = await Promise.all([
    redis.exists(keys.denyJti(String(claims.jti))),
    redis.exists(keys.denyUser(String(claims.sub))),
  ]);
  if (jtiDenied || userDenied) throw new HttpError(401, 'revoked token');
  const user = await getUser(String(claims.sub));
  if (!user || user.status !== 'ACTIVE') throw new HttpError(401, 'inactive user');
  const access = await resolveForApp(user.id, config.internalAppId);
  req.admin = {
    userId: user.id,
    access,
    jti: claims.jti ? String(claims.jti) : undefined,
    exp: claims.exp,
  };
}

function need(req: FastifyRequest, permission: string, resource: Record<string, string> = {}) {
  if (!req.admin || !checkPermission(req.admin.access, permission, resource)) throw new HttpError(403, `missing permission ${permission}`);
}

/** Does the caller hold full PII access (unrestricted write/import/super-admin) as opposed to scoped APP_ADMIN? */
function hasFullPiiAccess(access: EffectiveAccess): boolean {
  return (
    checkPermission(access, 'admin:all') ||
    checkPermission(access, 'users:write') ||
    checkPermission(access, 'users:import') ||
    checkPermission(access, 'users:export')
  );
}

/** null = unrestricted; otherwise the set of app ids a scoped admin may act on. */
function allowedApps(access: EffectiveAccess, permission: string): string[] | null {
  const alts = access.scopes_by_permission[permission] ?? [];
  if (alts.some((s) => Object.keys(s).length === 0)) return null;
  return [...new Set(alts.flatMap((s) => (s.app === undefined ? [] : ([] as Array<string | number>).concat(s.app).map(String))))];
}

const scopeSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]))
  .refine((obj) => Object.keys(obj).every((k) => !FORBIDDEN_SCOPE_KEYS.has(k)), {
    message: 'Invalid scope key',
  })
  .default({});

async function bumpAndPublish(userId: string, db = pool) {
  const v = await bumpAclVersion(userId, db);
  if (v) await publishAclVersion(userId, v);
  return v;
}

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'validation_error', issues: err.issues });
    if (err.validation) return reply.code(400).send({ error: 'validation_error', message: err.message });
    if (err.code === '23505') return reply.code(409).send({ error: 'conflict', ...(isProd ? {} : { detail: err.detail }) });
    if (err.code === '23503') return reply.code(400).send({ error: 'invalid_reference', ...(isProd ? {} : { detail: err.detail }) });
    if (err.code === '23514') return reply.code(400).send({ error: 'constraint_violation' });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'internal_error' });
  });
}

export async function adminRoutes(app: FastifyInstance) {
  registerErrorHandler(app);

  // Client-authenticated (apps) check endpoint is registered outside the admin auth hook.
  app.post('/v1/authorize/check', async (req, reply) => {
    const b = z.object({
      client_id: z.string(),
      client_secret: z.string(),
      user: z.string(),
      app: z.string(),
      permission: z.string(),
      scope: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
    }).parse(req.body);
    const client = (await pool.query(`SELECT * FROM applications WHERE id=$1 AND status='ACTIVE'`, [b.client_id])).rows[0];
    if (!client?.client_secret_hash || !safeCompareHex(sha256(b.client_secret), client.client_secret_hash)) {
      return reply.code(401).send({ error: 'invalid_client' });
    }
    if (b.app !== client.id) return reply.code(403).send({ error: 'apps may only check their own permissions' });
    const user = await getUser(b.user);
    if (!user || user.status !== 'ACTIVE') return { allowed: false, reason: 'inactive_user' };
    const access = await resolveForApp(user.id, b.app);
    return { allowed: checkPermission(access, b.permission, b.scope) };
  });

  // BFF silent session refresh using httpOnly refresh cookie
  app.post('/api/admin/auth/refresh', async (req, reply) => {
    enforceCookieCsrf(req);
    const refreshCookie = req.cookies.acl_admin_refresh;
    if (!refreshCookie) throw new HttpError(401, 'missing refresh cookie');
    const r = await rotateRefresh(refreshCookie, config.internalAppId);
    if (!r.ok) {
      reply.clearCookie('acl_admin_session', { path: '/' });
      reply.clearCookie('acl_admin_refresh', { path: '/' });
      throw new HttpError(401, 'invalid or expired refresh cookie');
    }
    const user = await getUser(r.userId);
    if (!user || user.status !== 'ACTIVE') {
      reply.clearCookie('acl_admin_session', { path: '/' });
      reply.clearCookie('acl_admin_refresh', { path: '/' });
      throw new HttpError(401, 'inactive user');
    }
    const at = await issueAccessToken(user, config.internalAppId);
    reply.setCookie('acl_admin_session', at.token, {
      path: '/',
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      maxAge: at.expiresIn,
    });
    reply.setCookie('acl_admin_refresh', r.refresh, {
      path: '/',
      httpOnly: true,
      secure: isProd,
      sameSite: 'strict',
      maxAge: config.adminSessionTtlSec,
    });
    return { ok: true, expires_in: at.expiresIn };
  });

  // Vercel Cron / external scheduler endpoint for hourly role expiry & token cleanup sweep
  app.get('/api/cron/expiry-sweep', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (config.cronSecret) {
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (!token || !safeCompareHex(sha256(token), sha256(config.cronSecret))) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
    } else if (isProd) {
      return reply.code(401).send({ error: 'CRON_SECRET not configured' });
    }
    const result = await roleExpirySweep();
    return { ok: true, ...result };
  });

  await app.register(async (admin) => {
    admin.addHook('preHandler', adminAuth);

    // ---------------- BFF Admin Session ----------------
    admin.get('/api/admin/auth/me', async (req) => {
      if (!req.admin?.access.permissions.length) {
        throw new HttpError(403, 'Access denied: account holds no administrative permissions on this console');
      }
      const u = await getUser(req.admin.userId);
      const academic = await academicOf(req.admin.userId);
      return {
        user: {
          id: u?.id,
          email: u?.email,
          name: u?.name,
          status: u?.status,
          avatar_url: u?.avatar_url,
          academic,
        },
        access: req.admin.access,
        tenant: 'Netaji Subhas University of Technology',
      };
    });

    admin.post('/api/admin/auth/logout', async (req, reply) => {
      const refreshCookie = req.cookies.acl_admin_refresh;
      if (refreshCookie) await revokeRefresh(refreshCookie);
      await revokeAllForUser(req.admin!.userId, config.internalAppId);
      if (req.admin?.jti && req.admin?.exp) {
        await denyJti(req.admin.jti, req.admin.exp - Math.floor(Date.now() / 1000));
      }
      reply.clearCookie('acl_admin_session', { path: '/' });
      reply.clearCookie('acl_admin_refresh', { path: '/' });
      await audit({ actorId: req.admin!.userId, action: 'ADMIN_LOGOUT', appId: config.internalAppId, ip: req.ip });
      return reply.code(200).send({ ok: true });
    });

    // ---------------- Enterprise Telemetry Overview ----------------
    admin.get('/v1/overview/metrics', async (req) => {
      need(req, 'users:read');
      const [uCount, rollCount, deptCount, appCount, assignCount, auditRecent] = await Promise.all([
        pool.query(`SELECT count(*)::int as count FROM users`),
        pool.query(`SELECT count(*)::int as count FROM users WHERE roll_no IS NOT NULL`),
        pool.query(`SELECT count(DISTINCT dept)::int as count FROM users WHERE dept IS NOT NULL AND dept != ''`),
        pool.query(`SELECT count(*)::int as count FROM applications WHERE status='ACTIVE' AND id != $1`, [config.internalAppId]),
        pool.query(`SELECT count(*)::int as count FROM user_app_roles WHERE (expires_at IS NULL OR expires_at > now()) AND app_id != $1`, [config.internalAppId]),
        pool.query(`SELECT count(*)::int as count FROM audit_logs WHERE created_at >= now() - interval '24 hours'`),
      ]);
      return {
        metrics: {
          totalUsers: uCount.rows[0].count,
          totalWithRollNo: rollCount.rows[0].count,
          totalDepartments: deptCount.rows[0].count,
          activeApps: appCount.rows[0].count,
          activeAssignments: assignCount.rows[0].count,
          authEvents24h: auditRecent.rows[0].count,
        },
      };
    });

    // ---------------- Directory ----------------
    admin.get('/v1/departments', async (req) => {
      need(req, 'users:read');
      const r = await pool.query(
        `SELECT DISTINCT dept FROM users WHERE dept IS NOT NULL AND dept != '' ORDER BY dept ASC`,
      );
      return { departments: r.rows.map((row) => row.dept as string) };
    });

    admin.get('/v1/users', async (req) => {
      need(req, 'users:read');
      const fullPii = hasFullPiiAccess(req.admin!.access);
      const q = z.object({
        q: z.string().optional(),
        dept: z.string().optional(),
        status: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }).parse(req.query);

      const safeQ = q.q ? escapeLike(q.q) : null;
      const safeDept = q.dept ? escapeLike(q.dept) : null;

      const [r, countRes] = await Promise.all([
        pool.query(
          `SELECT id, email, name, status,
                  roll_no, twelve_digit_roll_no, dept, branch, degree,
                  year, semester, section, group_no, batch_no, batch_year
             FROM users
            WHERE ($1::text IS NULL OR email ILIKE '%'||$1||'%' ESCAPE '\\' OR name ILIKE '%'||$1||'%' ESCAPE '\\' OR roll_no ILIKE '%'||$1||'%' ESCAPE '\\' OR twelve_digit_roll_no::text ILIKE '%'||$1||'%' ESCAPE '\\')
              AND ($2::text IS NULL OR dept ILIKE '%'||$2||'%' ESCAPE '\\' OR branch ILIKE '%'||$2||'%' ESCAPE '\\')
              AND ($3::text IS NULL OR status=$3)
            ORDER BY created_at DESC LIMIT $4 OFFSET $5`,
          [safeQ, safeDept, q.status ?? null, q.limit, q.offset],
        ),
        pool.query(
          `SELECT count(*)::int as total
             FROM users
            WHERE ($1::text IS NULL OR email ILIKE '%'||$1||'%' ESCAPE '\\' OR name ILIKE '%'||$1||'%' ESCAPE '\\' OR roll_no ILIKE '%'||$1||'%' ESCAPE '\\' OR twelve_digit_roll_no::text ILIKE '%'||$1||'%' ESCAPE '\\')
              AND ($2::text IS NULL OR dept ILIKE '%'||$2||'%' ESCAPE '\\' OR branch ILIKE '%'||$2||'%' ESCAPE '\\')
              AND ($3::text IS NULL OR status=$3)`,
          [safeQ, safeDept, q.status ?? null],
        ),
      ]);
      const users = fullPii ? r.rows : r.rows.map((u) => ({ ...u, twelve_digit_roll_no: null }));
      return { users, total: countRes.rows[0].total, limit: q.limit, offset: q.offset };
    });

    const userBody = z.object({
      email: z.string().email(),
      name: z.string().min(1),
      dept: z.string().optional(),
      branch: z.string().optional(),
      degree: z.string().optional(),
      roll_no: z.string().optional(),
      twelve_digit_roll_no: z.string().optional(),
      year: z.number().int().optional(),
      semester: z.number().int().optional(),
      section: z.number().int().optional(),
      group_no: z.number().int().optional(),
      batch_no: z.number().int().optional(),
      batch_year: z.number().int().optional(),
      employee_id: z.string().optional(),
      designation: z.string().optional(),
      mobile_no: z.string().optional(),
    });

    admin.post('/v1/users', async (req, reply) => {
      need(req, 'users:write');
      const raw = (req.body ?? {}) as any;
      const b = userBody.parse({
        ...raw,
        ...(raw.student ?? {}),
        ...(raw.faculty ?? {}),
      });
      const id = newId('usr');
      await tx(async (c) => {
        await c.query(
          `INSERT INTO users (
             id, email, name, dept, branch, degree, roll_no,
             twelve_digit_roll_no, year, semester, section, group_no, batch_no, batch_year,
             employee_id, designation, mobile_no
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            id,
            b.email.toLowerCase(),
            b.name,
            b.dept ?? null,
            b.branch ?? null,
            b.degree ?? null,
            b.roll_no ? b.roll_no.toUpperCase() : null,
            b.twelve_digit_roll_no ?? null,
            b.year ?? null,
            b.semester ?? null,
            b.section ?? null,
            b.group_no ?? null,
            b.batch_no ?? null,
            b.batch_year ?? null,
            b.employee_id ? b.employee_id.trim() : null,
            b.designation ? b.designation.trim() : null,
            b.mobile_no ? b.mobile_no.trim() : null,
          ],
        );
        await audit({ actorId: req.admin!.userId, action: 'USER_CREATED', targetType: 'user', targetId: id, ip: req.ip }, c);
      });
      return reply.code(201).send({ id });
    });

    admin.get('/v1/users/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const self = id === req.admin!.userId;
      if (!self) need(req, 'users:read');
      const user = await getUser(id);
      if (!user) return reply.code(404).send({ error: 'not_found' });
      const includeSensitive = self || hasFullPiiAccess(req.admin!.access);
      return { ...sanitizeUser(user, includeSensitive), academic: await academicOf(id, includeSensitive) };
    });

    admin.patch('/v1/users/:id', async (req, reply) => {
      need(req, 'users:write');
      const { id } = req.params as { id: string };
      const b = z.object({
        name: z.string().min(1).optional(),
        status: z.enum(['ACTIVE', 'SUSPENDED', 'ARCHIVED']).optional(),
        dept: z.string().optional(),
        branch: z.string().optional(),
        degree: z.string().optional(),
        roll_no: z.string().optional(),
        twelve_digit_roll_no: z.string().optional(),
        year: z.number().int().optional(),
        semester: z.number().int().optional(),
        section: z.number().int().optional(),
        group_no: z.number().int().optional(),
        batch_no: z.number().int().optional(),
        batch_year: z.number().int().optional(),
        employee_id: z.string().optional(),
        designation: z.string().optional(),
        mobile_no: z.string().optional(),
      }).parse(req.body);

      if (id === req.admin!.userId && b.status && b.status !== 'ACTIVE') throw new HttpError(400, 'cannot deactivate yourself');
      const found = await getUser(id);
      if (!found) return reply.code(404).send({ error: 'not_found' });

      // Prevent suspending/archiving the last active SUPER_ADMIN
      if (b.status && b.status !== 'ACTIVE') {
        const superCheck = await pool.query(
          `SELECT count(DISTINCT r.user_id)::int AS count
             FROM user_app_roles r
             JOIN users u ON u.id = r.user_id
            WHERE r.app_id = $1 AND r.role = 'SUPER_ADMIN'
              AND (r.expires_at IS NULL OR r.expires_at > now())
              AND u.status = 'ACTIVE' AND u.id != $2`,
          [config.internalAppId, id],
        );
        const targetIsSuper = await pool.query(
          `SELECT 1 FROM user_app_roles WHERE user_id = $1 AND app_id = $2 AND role = 'SUPER_ADMIN' AND (expires_at IS NULL OR r.expires_at > now())`.replace(
            'r.expires_at',
            'expires_at',
          ),
          [id, config.internalAppId],
        );
        if (targetIsSuper.rowCount && (superCheck.rows[0]?.count ?? 0) === 0) {
          throw new HttpError(400, 'Cannot deactivate the last active SUPER_ADMIN');
        }
      }

      const entries = Object.entries(b).filter(([, v]) => v !== undefined);
      for (const [k] of entries) {
        if (!ALLOWED_USER_UPDATE_COLUMNS.has(k)) {
          throw new HttpError(400, `Invalid update column: ${k}`);
        }
      }
      // Record only field names (not raw PII values like mobile_no) in the immutable audit log (DPDP compliance)
      const auditMeta = {
        updated_fields: entries.map(([k]) => k),
        ...(b.status ? { status: b.status } : {}),
      };

      await tx(async (c) => {
        if (entries.length) {
          const sets = entries.map(([k], i) => `${k}=$${i + 2}`).join(', ');
          const vals = entries.map(([, v]) => v);
          await c.query(`UPDATE users SET ${sets}, updated_at=now() WHERE id=$1`, [id, ...vals]);
        }
        await audit({ actorId: req.admin!.userId, action: 'PROFILE_UPDATED', targetType: 'user', targetId: id, ip: req.ip, metadata: auditMeta }, c);
      });

      await bumpAndPublish(id);
      if (b.status && b.status !== 'ACTIVE') {
        await revokeAllForUser(id);
        await denyUserTokens(id);
      } else if (b.status === 'ACTIVE') {
        await clearUserDeny(id);
      }
      return { ok: true };
    });

    // DPDP Act Right-to-Erasure / Anonymization for archived/departed users
    admin.post('/v1/users/:id/anonymize', async (req, reply) => {
      need(req, 'users:write');
      need(req, 'admin:all');
      const { id } = req.params as { id: string };
      if (id === req.admin!.userId) throw new HttpError(400, 'cannot anonymize yourself');
      const found = await getUser(id);
      if (!found) return reply.code(404).send({ error: 'not_found' });

      const anonEmail = `deleted+${id.toLowerCase()}@${config.allowedDomain}`;
      await tx(async (c) => {
        await c.query(`DELETE FROM user_app_roles WHERE user_id = $1`, [id]);
        await c.query(`DELETE FROM user_permission_overrides WHERE user_id = $1`, [id]);
        await c.query(
          `UPDATE users
              SET email = $2,
                  name = 'Anonymized User',
                  google_sub = NULL,
                  avatar_url = NULL,
                  roll_no = NULL,
                  twelve_digit_roll_no = NULL,
                  employee_id = NULL,
                  designation = NULL,
                  mobile_no = NULL,
                  dept = NULL,
                  branch = NULL,
                  degree = NULL,
                  year = NULL,
                  semester = NULL,
                  section = NULL,
                  group_no = NULL,
                  batch_no = NULL,
                  batch_year = NULL,
                  status = 'ARCHIVED',
                  acl_version = COALESCE(acl_version, 1) + 1,
                  updated_at = now()
            WHERE id = $1`,
          [id, anonEmail],
        );
        await audit({ actorId: req.admin!.userId, action: 'USER_ANONYMIZED', targetType: 'user', targetId: id, ip: req.ip }, c);
      });
      await revokeAllForUser(id);
      await denyUserTokens(id);
      await publishAclVersion(id);
      return { ok: true };
    });

    admin.post('/v1/users/import', async (req, reply) => {
      need(req, 'users:import');
      const csv = typeof req.body === 'string' ? req.body : (req.body as any)?.csv;
      if (!csv || typeof csv !== 'string') throw new HttpError(400, 'send CSV as text/csv body or {"csv": "..."}');
      const q = req.query as { filename?: string };
      const filename = q.filename || 'campus_roster.csv';
      const jid = newId('job');
      const user = await getUser(req.admin!.userId);

      await createJobRecord({
        id: jid,
        type: 'IMPORT',
        actorId: req.admin!.userId,
        actorEmail: user?.email,
        filename,
      });

      if (isServerless) {
        await importUsersCsv(csv, req.admin!.userId, jid).catch(() => {});
      } else {
        await getQueue().add(
          'import-users',
          { csv, actorId: req.admin!.userId },
          { jobId: jid },
        );
      }
      return reply.code(202).send({ job_id: jid });
    });

    admin.post('/v1/users/export', async (req, reply) => {
      if (!checkPermission(req.admin!.access, 'users:export') && !checkPermission(req.admin!.access, 'admin:all')) {
        throw new HttpError(403, 'missing permission users:export');
      }
      const q = z.object({ dept: z.string().optional(), status: z.string().optional() }).parse(req.query ?? {});
      const jid = newId('job');
      const user = await getUser(req.admin!.userId);
      const filename = `campus_directory_export_${Date.now()}.csv`;

      await createJobRecord({
        id: jid,
        type: 'EXPORT',
        actorId: req.admin!.userId,
        actorEmail: user?.email,
        filename,
        metadata: q,
      });

      await audit({
        actorId: req.admin!.userId,
        action: 'USERS_EXPORT_REQUESTED',
        targetType: 'job',
        targetId: jid,
        ip: req.ip,
        metadata: q,
      });

      if (isServerless) {
        await exportUsersCsv(q, req.admin!.userId, jid).catch(() => {});
      } else {
        await getQueue().add(
          'export-users',
          { opts: q, actorId: req.admin!.userId },
          { jobId: jid },
        );
      }
      return reply.code(202).send({ job_id: jid });
    });

    admin.post('/v1/users/rollover', async (req, reply) => {
      need(req, 'users:write');
      need(req, 'admin:all');
      const b = z.object({ max_semester: z.number().int().min(1).optional(), force: z.boolean().optional() }).parse(req.body ?? {});

      if (!b.force) {
        const recentRollover = await pool.query(
          `SELECT id, status, created_at FROM ingestion_jobs
            WHERE type = 'ROLLOVER' AND status IN ('QUEUED', 'PROCESSING', 'COMPLETED')
              AND created_at >= now() - interval '24 hours'
            ORDER BY created_at DESC LIMIT 1`,
        );
        if (recentRollover.rowCount) {
          throw new HttpError(
            409,
            'Semester rollover was already executed within the last 24 hours. Pass {"force": true} to override.',
          );
        }
      }

      const jid = newId('job');
      const user = await getUser(req.admin!.userId);

      await createJobRecord({
        id: jid,
        type: 'ROLLOVER',
        actorId: req.admin!.userId,
        actorEmail: user?.email,
        filename: 'semester_rollover',
        metadata: { max_semester: b.max_semester ?? 8 },
      });

      if (isServerless) {
        await semesterRollover({ maxSemester: b.max_semester }, req.admin!.userId, jid).catch(() => {});
      } else {
        await getQueue().add(
          'rollover',
          { opts: { maxSemester: b.max_semester }, actorId: req.admin!.userId },
          { jobId: jid },
        );
      }
      return reply.code(202).send({ job_id: jid });
    });

    admin.get('/v1/jobs', async (req) => {
      need(req, 'users:read');
      const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query ?? {});
      const jobs = await listJobs(q.limit, q.offset);
      return { jobs };
    });

    admin.get('/v1/jobs/:id', async (req, reply) => {
      need(req, 'users:read');
      const { id } = req.params as { id: string };
      const dbJob = await getJobRecord(id);
      const qJob = isServerless ? null : await getQueue().getJob(id);

      if (!dbJob && !qJob) return reply.code(404).send({ error: 'not_found' });

      return {
        id,
        type: dbJob?.type ?? (qJob?.name === 'import-users' ? 'IMPORT' : qJob?.name === 'export-users' ? 'EXPORT' : 'ROLLOVER'),
        status: dbJob?.status ?? ((await qJob?.getState())?.toUpperCase() ?? 'QUEUED'),
        progress_pct: dbJob?.progress_pct ?? (qJob ? (typeof qJob.progress === 'number' ? qJob.progress : 0) : 0),
        total_rows: dbJob?.total_rows ?? 0,
        processed_rows: dbJob?.processed_rows ?? 0,
        created_count: dbJob?.created_count ?? 0,
        updated_count: dbJob?.updated_count ?? 0,
        failed_count: dbJob?.failed_count ?? 0,
        filename: dbJob?.filename ?? null,
        actor_email: dbJob?.actor_email ?? null,
        error_message: dbJob?.error_message ?? qJob?.failedReason ?? null,
        metadata: dbJob?.metadata ?? qJob?.returnvalue ?? {},
        started_at: dbJob?.started_at ?? null,
        completed_at: dbJob?.completed_at ?? null,
        created_at: dbJob?.created_at ?? (qJob?.timestamp ? new Date(qJob.timestamp) : new Date()),
      };
    });

    admin.get('/v1/jobs/:id/download.csv', async (req, reply) => {
      need(req, 'users:read');
      const { id } = req.params as { id: string };
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new HttpError(400, 'invalid job id');
      const dbJob = await getJobRecord(id);
      const canDownload =
        hasFullPiiAccess(req.admin!.access) || (dbJob?.actor_id && dbJob.actor_id === req.admin!.userId);
      if (!canDownload) {
        throw new HttpError(403, 'Access denied: only the job creator or a directory administrator may download export files');
      }
      const csv = await redis.get(`job:export:${id}`);
      if (!csv) return reply.code(404).send({ error: 'Export file not found or expired' });
      await audit({
        actorId: req.admin!.userId,
        action: 'USERS_EXPORT_DOWNLOADED',
        targetType: 'job',
        targetId: id,
        ip: req.ip,
      });
      reply.header('content-type', 'text/csv');
      reply.header('content-disposition', `attachment; filename="campus_directory_export_${id}.csv"`);
      return reply.send(csv);
    });

    admin.get('/v1/jobs/:id/errors.csv', async (req, reply) => {
      need(req, 'users:read');
      const { id } = req.params as { id: string };
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new HttpError(400, 'invalid job id');
      const dbJob = await getJobRecord(id);
      const canDownload =
        hasFullPiiAccess(req.admin!.access) || (dbJob?.actor_id && dbJob.actor_id === req.admin!.userId);
      if (!canDownload) {
        throw new HttpError(403, 'Access denied: only the job creator or a directory administrator may download error reports');
      }
      const csv = await redis.get(`job:errors:${id}`);
      if (!csv) return reply.code(404).send({ error: 'Error report not found or expired' });
      await audit({
        actorId: req.admin!.userId,
        action: 'IMPORT_ERRORS_DOWNLOADED',
        targetType: 'job',
        targetId: id,
        ip: req.ip,
      });
      reply.header('content-type', 'text/csv');
      reply.header('content-disposition', `attachment; filename="import-errors-${id}.csv"`);
      return reply.send(csv);
    });

    // ---------------- Apps & roles ----------------
    admin.get('/v1/apps', async (req) => {
      need(req, 'users:read');
      const r = await pool.query(
        `SELECT a.id,a.name,a.redirect_uris,a.status,a.created_at,
                (a.client_secret_hash IS NOT NULL) AS confidential,
                COALESCE((SELECT json_agg(json_build_object('role',r.role,'is_default',r.is_default,'description',r.description,
                   'permissions',(SELECT COALESCE(json_agg(rp.permission ORDER BY rp.permission),'[]') FROM role_permissions rp WHERE rp.app_id=r.app_id AND rp.role=r.role)))
                   FROM app_roles r WHERE r.app_id=a.id),'[]') AS roles,
                COALESCE((SELECT json_agg(p.permission ORDER BY p.permission) FROM app_permissions p WHERE p.app_id=a.id),'[]') AS permissions
           FROM applications a
          ORDER BY a.id`,
      );
      return { apps: r.rows };
    });

    admin.post('/v1/apps', async (req, reply) => {
      need(req, 'apps:manage');
      const b = z.object({
        id: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/),
        name: z.string().min(1),
        redirect_uris: z.array(z.string().url()).min(1),
        confidential: z.boolean().default(false),
      }).parse(req.body);
      if (b.id === config.internalAppId) throw new HttpError(400, 'Reserved application ID');
      for (const u of b.redirect_uris) {
        if (u.includes('*') || u.includes('#')) {
          throw new HttpError(400, 'redirect URIs must be exact (no wildcards/fragments)');
        }
        const parsed = new URL(u);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          throw new HttpError(400, 'redirect URIs must use http or https protocol');
        }
        if (isProd && parsed.protocol !== 'https:') {
          throw new HttpError(400, 'redirect URIs must use https in production');
        }
      }
      const secret = b.confidential ? randomToken(32) : null;
      await pool.query(`INSERT INTO applications (id,name,client_secret_hash,redirect_uris) VALUES ($1,$2,$3,$4)`,
        [b.id, b.name, secret ? sha256(secret) : null, b.redirect_uris]);
      await audit({ actorId: req.admin!.userId, action: 'APP_REGISTERED', targetType: 'app', targetId: b.id, appId: b.id, ip: req.ip });
      // Secret is shown exactly once.
      return reply.code(201).send({ client_id: b.id, ...(secret ? { client_secret: secret } : {}) });
    });

    admin.delete('/v1/apps/:app', async (req, reply) => {
      const { app: appId } = req.params as { app: string };
      need(req, 'apps:manage');
      if (appId === config.internalAppId) {
        throw new HttpError(400, 'Cannot delete the internal system identity application');
      }
      const deleted = await tx(async (c) => {
        const r = await c.query(`DELETE FROM applications WHERE id = $1 RETURNING id`, [appId]);
        if (!r.rowCount) return false;
        await audit({
          actorId: req.admin!.userId,
          action: 'APP_DELETED',
          targetType: 'app',
          targetId: appId,
          appId,
          ip: req.ip,
        }, c);
        return true;
      });
      if (!deleted) return reply.code(404).send({ error: 'not_found' });
      return reply.code(204).send();
    });

    admin.put('/v1/apps/:app/permissions', async (req, reply) => {
      const { app: appId } = req.params as { app: string };
      need(req, 'apps:manage');
      if (appId === config.internalAppId) need(req, 'admin:all');
      const b = z.object({ permissions: z.array(z.object({ permission: z.string().regex(/^[a-z_]+:[a-z_]+$/), description: z.string().optional() })) }).parse(req.body);
      await tx(async (c) => {
        for (const p of b.permissions) {
          await c.query(`INSERT INTO app_permissions (app_id,permission,description) VALUES ($1,$2,$3)
                         ON CONFLICT (app_id,permission) DO UPDATE SET description=EXCLUDED.description`, [appId, p.permission, p.description ?? null]);
        }
        await audit({ actorId: req.admin!.userId, action: 'PERMISSIONS_DEFINED', targetType: 'app', targetId: appId, appId, metadata: { count: b.permissions.length } }, c);
      });
      return reply.send({ ok: true });
    });

    admin.put('/v1/apps/:app/roles', async (req, reply) => {
      const { app: appId } = req.params as { app: string };
      need(req, 'apps:manage');
      if (appId === config.internalAppId) need(req, 'admin:all');
      const b = z.object({ roles: z.array(z.object({
        role: z.string().regex(/^[A-Z][A-Z0-9_]*$/), description: z.string().optional(),
        permissions: z.array(z.string()), is_default: z.boolean().default(false),
        default_scope: z
          .record(z.string(), z.string())
          .refine(
            (obj) =>
              Object.entries(obj).every(
                ([k, field]) => !FORBIDDEN_SCOPE_KEYS.has(k) && SAFE_DEFAULT_SCOPE_FIELDS.has(field),
              ),
            { message: 'default_scope may only reference non-sensitive academic user fields' },
          )
          .default({}),
      })) }).parse(req.body);
      const changedRoles = b.roles.map((r) => r.role);
      const affected = await tx(async (c) => {
        for (const r of b.roles) {
          await c.query(`INSERT INTO app_roles (app_id,role,description,is_default,default_scope) VALUES ($1,$2,$3,$4,$5)
                         ON CONFLICT (app_id,role) DO UPDATE SET description=EXCLUDED.description,is_default=EXCLUDED.is_default,default_scope=EXCLUDED.default_scope`,
            [appId, r.role, r.description ?? null, r.is_default, r.default_scope]);
          await c.query(`DELETE FROM role_permissions WHERE app_id=$1 AND role=$2`, [appId, r.role]);
          for (const p of r.permissions) await c.query(`INSERT INTO role_permissions (app_id,role,permission) VALUES ($1,$2,$3)`, [appId, r.role, p]);
        }
        // Collect all users who currently have any role in this app before deletion
        const allAppUsers = (await c.query(`SELECT DISTINCT user_id FROM user_app_roles WHERE app_id=$1`, [appId])).rows;
        // Remove roles that are no longer present for this application
        await c.query(`DELETE FROM app_roles WHERE app_id=$1 AND NOT (role = ANY($2))`, [appId, changedRoles]);
        await audit({ actorId: req.admin!.userId, action: 'ROLES_DEFINED', targetType: 'app', targetId: appId, appId, metadata: { roles: changedRoles } }, c);
        return allAppUsers;
      });
      for (const u of affected) await bumpAndPublish(u.user_id); // role definition changed => tokens stale
      return reply.send({ ok: true });
    });

    // ---------------- Resources & permissions catalog ----------------
    admin.get('/v1/resources', async (req) => {
      need(req, 'users:read');
      const q = req.query as { include_internal?: string };
      const includeInternal = q?.include_internal === 'true';
      const r = await pool.query(
        `SELECT p.app_id,
                a.name AS app_name,
                p.permission,
                p.description,
                COALESCE((
                  SELECT json_agg(rp.role ORDER BY rp.role)
                  FROM role_permissions rp
                  WHERE rp.app_id = p.app_id AND rp.permission = p.permission
                ), '[]') AS roles
         FROM app_permissions p
         JOIN applications a ON a.id = p.app_id
         WHERE ($1::boolean = true OR p.app_id != $2)
         ORDER BY p.app_id, p.permission`,
        [includeInternal, config.internalAppId],
      );
      return { resources: r.rows };
    });

    admin.post('/v1/resources', async (req, reply) => {
      need(req, 'apps:manage');
      const b = z.object({
        app_id: z.string(),
        permission: z.string().regex(/^[a-z0-9_]+:[a-z0-9_]+$/),
        description: z.string().optional(),
      }).parse(req.body);

      const app = (await pool.query(`SELECT id FROM applications WHERE id=$1`, [b.app_id])).rows[0];
      if (!app) return reply.code(404).send({ error: 'app_not_found' });

      await tx(async (c) => {
        await c.query(
          `INSERT INTO app_permissions (app_id, permission, description)
           VALUES ($1, $2, $3)
           ON CONFLICT (app_id, permission) DO UPDATE SET description = EXCLUDED.description`,
          [b.app_id, b.permission, b.description ?? null],
        );
        await audit({
          actorId: req.admin!.userId,
          action: 'RESOURCE_CREATED',
          targetType: 'resource',
          targetId: `${b.app_id}:${b.permission}`,
          appId: b.app_id,
          ip: req.ip,
          metadata: { permission: b.permission, description: b.description },
        }, c);
      });

      return reply.code(201).send({ ok: true });
    });

    admin.delete('/v1/resources/:app/:permission', async (req, reply) => {
      const { app: appId, permission } = req.params as { app: string; permission: string };
      need(req, 'apps:manage');
      const removed = await tx(async (c) => {
        const r = await c.query(
          `DELETE FROM app_permissions WHERE app_id = $1 AND permission = $2 RETURNING permission`,
          [appId, permission],
        );
        if (!r.rowCount) return null;
        await audit({
          actorId: req.admin!.userId,
          action: 'RESOURCE_DELETED',
          targetType: 'resource',
          targetId: `${appId}:${permission}`,
          appId,
          ip: req.ip,
          metadata: { permission },
        }, c);
        return r.rows[0];
      });
      if (!removed) return reply.code(404).send({ error: 'not_found' });
      return reply.code(204).send();
    });

    // ---------------- ACL assignment ----------------
    admin.post('/v1/users/:id/apps/:app/roles', async (req, reply) => {
      const { id, app: appId } = req.params as { id: string; app: string };
      need(req, 'roles:assign', { app: appId });
      const b = z.object({ role: z.string(), scope: scopeSchema, expires_at: z.string().datetime().nullish() }).parse(req.body);
      // Only super admins may grant roles of the internal ACL app (prevents escalation).
      if (appId === config.internalAppId) need(req, 'admin:all');
      if (!(await getUser(id))) return reply.code(404).send({ error: 'not_found' });
      const aid = newId('uar');
      await tx(async (c) => {
        await c.query(`INSERT INTO user_app_roles (id,user_id,app_id,role,scope,granted_by,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [aid, id, appId, b.role, b.scope, req.admin!.userId, b.expires_at ?? null]);
        await bumpAclVersion(id, c);
        await audit({ actorId: req.admin!.userId, action: 'ROLE_GRANTED', targetType: 'user', targetId: id, appId, ip: req.ip,
          metadata: { role: b.role, scope: b.scope, expires_at: b.expires_at ?? null, assignment_id: aid } }, c);
      });
      await publishAclVersion(id);
      return reply.code(201).send({ id: aid });
    });

    admin.delete('/v1/users/:id/apps/:app/roles/:assignmentId', async (req, reply) => {
      const { id, app: appId, assignmentId } = req.params as { id: string; app: string; assignmentId: string };
      need(req, 'roles:assign', { app: appId });
      if (appId === config.internalAppId) need(req, 'admin:all');
      const removed = await tx(async (c) => {
        if (appId === config.internalAppId) {
          const targetRole = await c.query(`SELECT role FROM user_app_roles WHERE id=$1 AND user_id=$2 AND app_id=$3`, [assignmentId, id, appId]);
          if (targetRole.rows[0]?.role === 'SUPER_ADMIN') {
            const remaining = await c.query(
              `SELECT count(DISTINCT r.user_id)::int AS count
                 FROM user_app_roles r
                 JOIN users u ON u.id = r.user_id
                WHERE r.app_id = $1 AND r.role = 'SUPER_ADMIN'
                  AND r.id != $2
                  AND (r.expires_at IS NULL OR r.expires_at > now())
                  AND u.status = 'ACTIVE'`,
              [config.internalAppId, assignmentId],
            );
            if ((remaining.rows[0]?.count ?? 0) === 0) {
              throw new HttpError(400, 'Cannot revoke the last active SUPER_ADMIN assignment');
            }
          }
        }
        const r = await c.query(`DELETE FROM user_app_roles WHERE id=$1 AND user_id=$2 AND app_id=$3 RETURNING role, scope`, [assignmentId, id, appId]);
        if (!r.rowCount) return null;
        await bumpAclVersion(id, c);
        await audit({ actorId: req.admin!.userId, action: 'ROLE_REVOKED', targetType: 'user', targetId: id, appId, ip: req.ip, metadata: { assignment_id: assignmentId, ...r.rows[0] } }, c);
        return r.rows[0];
      });
      if (!removed) return reply.code(404).send({ error: 'not_found' });
      await publishAndRevokeCache(id);
      return reply.code(204).send();
    });

    admin.get('/v1/users/:id/access', async (req, reply) => {
      const { id } = req.params as { id: string };
      if (id !== req.admin!.userId) need(req, 'users:read');
      const user = await getUser(id);
      if (!user) return reply.code(404).send({ error: 'not_found' });
      const apps = (await pool.query(`SELECT id,name FROM applications WHERE status='ACTIVE' ORDER BY id`)).rows;
      const assignments = (await pool.query(`SELECT id,app_id,role,scope,granted_by,granted_at,expires_at FROM user_app_roles WHERE user_id=$1`, [id])).rows;
      const out = [];
      for (const a of apps) {
        const eff = await resolveForApp(id, a.id);
        out.push({ app: a.id, name: a.name, role: eff.role, roles: eff.roles, permissions: eff.permissions, scope: eff.scope,
          implicit_default: eff.implicitDefault, assignments: assignments.filter((x) => x.app_id === a.id) });
      }
      return { user: { id: user.id, email: user.email, name: user.name, status: user.status }, access: out };
    });

    // ---------------- Audit ----------------
    admin.get('/v1/audit', async (req) => {
      // Scoped admins hold audit:view only for specific apps; rows are filtered below.
      if (!req.admin!.access.permissions.includes('audit:view')) throw new HttpError(403, 'missing permission audit:view');
      const q = z.object({ actor: z.string().optional(), target: z.string().optional(), app: z.string().optional(), action: z.string().optional(),
        from: z.string().datetime().optional(), to: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
      const apps = allowedApps(req.admin!.access, 'audit:view');
      const r = await pool.query(
        `SELECT a.*,
                u_actor.email AS actor_email, u_actor.name AS actor_name,
                u_target.email AS target_email, u_target.name AS target_name
          FROM audit_logs a
          LEFT JOIN users u_actor ON a.actor_id = u_actor.id
          LEFT JOIN users u_target ON a.target_id = u_target.id
          WHERE ($1::text IS NULL OR a.actor_id=$1) AND ($2::text IS NULL OR a.target_id=$2) AND ($3::text IS NULL OR a.app_id=$3)
            AND ($4::text IS NULL OR a.action=$4) AND ($5::timestamptz IS NULL OR a.created_at>=$5) AND ($6::timestamptz IS NULL OR a.created_at<=$6)
            AND ($7::text[] IS NULL OR a.app_id = ANY($7))
          ORDER BY a.created_at DESC, a.id DESC LIMIT $8`,
        [q.actor ?? null, q.target ?? null, q.app ?? null, q.action ?? null, q.from ?? null, q.to ?? null, apps, q.limit],
      );
      return { entries: r.rows };
    });
  });
}

async function publishAndRevokeCache(userId: string) {
  await publishAclVersion(userId);
}
