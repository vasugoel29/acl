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
  type UserRow,
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

async function resolveAppId(rawIdOrSlug: string): Promise<string> {
  if (rawIdOrSlug === config.internalClientSlug || rawIdOrSlug === config.internalAppId) {
    return config.internalAppId;
  }
  const row = (await pool.query(`SELECT id FROM applications WHERE id = $1 OR client_id = $1`, [rawIdOrSlug])).rows[0];
  return row ? row.id : rawIdOrSlug;
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
  if (!req.admin) throw new HttpError(403, `missing permission ${permission}`);
  if (checkPermission(req.admin.access, permission, resource)) return;
  if (resource.app) {
    const alts = req.admin.access.scopes_by_permission[permission] ?? [];
    for (const alt of alts) {
      if (alt.app) {
        const allowed = Array.isArray(alt.app) ? alt.app.map(String) : [String(alt.app)];
        if (allowed.includes(resource.app) || (resource.raw_app && allowed.includes(resource.raw_app))) return;
      }
    }
  }
  throw new HttpError(403, `missing permission ${permission}`);
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
    const client = (await pool.query(`SELECT * FROM applications WHERE (id=$1 OR client_id=$1) AND status='ACTIVE'`, [b.client_id])).rows[0];
    if (!client?.client_secret_hash || !safeCompareHex(sha256(b.client_secret), client.client_secret_hash)) {
      return reply.code(401).send({ error: 'invalid_client' });
    }
    if (b.app !== client.id && b.app !== client.client_id) return reply.code(403).send({ error: 'apps may only check their own permissions' });
    const user = await getUser(b.user);
    if (!user || user.status !== 'ACTIVE') return { allowed: false, reason: 'inactive_user' };
    const access = await resolveForApp(user.id, b.app);
    return { allowed: checkPermission(access, b.permission, b.scope) };
  });

  // Client-authenticated (apps) direct user access endpoint (Server-to-Server)
  app.post('/v1/user-access', async (req, reply) => {
    let clientId: string | undefined;
    let clientSecret: string | undefined;

    const basic = req.headers.authorization?.startsWith('Basic ') ? req.headers.authorization.slice(6) : null;
    if (basic) {
      const [bid, bsec] = Buffer.from(basic, 'base64').toString().split(':');
      clientId = bid;
      clientSecret = bsec;
    }

    const b = z.object({
      client_id: z.string().optional(),
      client_secret: z.string().optional(),
      email: z.string().email().optional(),
      user_id: z.string().optional(),
      app: z.string().optional(),
    }).parse(req.body ?? {});

    clientId = clientId ?? b.client_id;
    clientSecret = clientSecret ?? b.client_secret;

    if (!clientId || !clientSecret) {
      return reply.code(401).send({ error: 'invalid_client', error_description: 'client_id and client_secret required' });
    }

    const client = (await pool.query(`SELECT * FROM applications WHERE (id=$1 OR client_id=$1) AND status='ACTIVE'`, [clientId])).rows[0];
    if (!client?.client_secret_hash || !safeCompareHex(sha256(clientSecret), client.client_secret_hash)) {
      return reply.code(401).send({ error: 'invalid_client', error_description: 'invalid client credentials' });
    }

    const targetApp = b.app ?? clientId;
    if (targetApp !== clientId && targetApp !== client.id && targetApp !== client.client_id) {
      return reply.code(403).send({ error: 'forbidden', error_description: 'apps may only query their own user access' });
    }

    if (!b.email && !b.user_id) {
      return reply.code(400).send({ error: 'invalid_request', error_description: 'either email or user_id is required' });
    }

    let user: UserRow | null = null;
    if (b.user_id) {
      user = await getUser(b.user_id);
    } else if (b.email) {
      const r = await pool.query(`SELECT * FROM users WHERE email=$1`, [b.email.trim().toLowerCase()]);
      user = r.rows[0] ?? null;
    }

    if (!user) {
      return reply.code(404).send({ error: 'user_not_found', error_description: 'user not found in directory' });
    }

    if (user.status !== 'ACTIVE') {
      return reply.code(403).send({ error: 'user_inactive', error_description: `user status is ${user.status}` });
    }

    const [access, academic] = await Promise.all([
      resolveForApp(user.id, targetApp),
      academicOf(user.id),
    ]);

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        type: (user as any).type ?? (user.employee_id ? 'FACULTY' : 'STUDENT'),
        status: user.status,
        ...(academic ? { academic } : {}),
      },
      app: targetApp,
      role: access.role,
      roles: access.roles,
      permissions: access.permissions,
      allowed_scope: access.scope,
      scopes_by_permission: access.scopes_by_permission,
    };
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
    admin.get('/api/admin/auth/me', async (req, reply) => {
      if (!req.admin?.access.permissions.length) {
        const refreshCookie = req.cookies.acl_admin_refresh;
        if (refreshCookie) await revokeRefresh(refreshCookie);
        reply.clearCookie('acl_admin_session', { path: '/' });
        reply.clearCookie('acl_admin_refresh', { path: '/' });
        throw new HttpError(
          403,
          'Access denied. Your account does not have administrative permissions to access the NSUT Identity Console.',
        );
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
    admin.get('/v1/users', async (req) => {
      need(req, 'users:read');
      const fullPii = hasFullPiiAccess(req.admin!.access);
      const q = z.object({
        q: z.string().optional(),
        dept: z.string().optional(),
        status: z.string().optional(),
        sort: z.enum(['name_asc', 'name_desc', 'roll_asc', 'newest']).default('name_asc'),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }).parse(req.query);

      const safeQ = q.q ? escapeLike(q.q) : null;
      const safeDept = q.dept ? escapeLike(q.dept) : null;

      const orderByClause =
        q.sort === 'name_desc'
          ? 'LOWER(name) DESC, email ASC'
          : q.sort === 'roll_asc'
            ? 'roll_no ASC NULLS LAST, LOWER(name) ASC'
            : q.sort === 'newest'
              ? 'created_at DESC'
              : 'LOWER(name) ASC, email ASC';

      const [r, countRes] = await Promise.all([
        pool.query(
          `SELECT id, email, name, status,
                  roll_no, twelve_digit_roll_no, dept, branch, degree,
                  year, semester, section, group_no, batch_no, batch_year
             FROM users
            WHERE ($1::text IS NULL OR email ILIKE '%'||$1||'%' ESCAPE '\\' OR name ILIKE '%'||$1||'%' ESCAPE '\\' OR roll_no ILIKE '%'||$1||'%' ESCAPE '\\' OR twelve_digit_roll_no::text ILIKE '%'||$1||'%' ESCAPE '\\')
              AND ($2::text IS NULL OR dept ILIKE '%'||$2||'%' ESCAPE '\\' OR branch ILIKE '%'||$2||'%' ESCAPE '\\')
              AND ($3::text IS NULL OR status=$3)
            ORDER BY ${orderByClause} LIMIT $4 OFFSET $5`,
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
                  designation_code = NULL,
                  mobile_no = NULL,
                  dept = NULL,
                  dept_code = NULL,
                  branch = NULL,
                  program_id = NULL,
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
        `SELECT a.id,a.client_id,a.name,a.redirect_uris,a.status,a.created_at,
                (a.client_secret_hash IS NOT NULL) AS confidential,
                COALESCE((SELECT json_agg(json_build_object('role',r.role,'is_default',r.is_default,'description',r.description,
                   'permissions',COALESCE(r.permissions, '{}')))
                   FROM app_roles r WHERE r.app_id=a.id),'[]') AS roles,
                COALESCE((SELECT json_agg(p.permission ORDER BY p.permission) FROM app_resources p WHERE p.app_id=a.id),'[]') AS permissions
           FROM applications a
          ORDER BY a.client_id, a.id`,
      );
      return { apps: r.rows };
    });

    admin.post('/v1/apps', async (req, reply) => {
      need(req, 'apps:manage');
      const b = z.object({
        id: z.string().optional(),
        client_id: z.string().regex(/^[A-Za-z0-9_]{1,32}$/).optional(),
        name: z.string().min(1),
        redirect_uris: z.array(z.string().url()).min(1),
        confidential: z.boolean().default(false),
      }).parse(req.body);
      const clientId = (b.client_id ?? b.id ?? '').toUpperCase();
      if (!clientId) throw new HttpError(400, 'client_id is required');
      if (clientId === config.internalClientSlug || clientId === config.internalAppId) {
        throw new HttpError(400, 'Reserved application ID');
      }
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
      const appId = b.id?.startsWith('app_') ? b.id : newId('app');
      const secret = b.confidential ? randomToken(32) : null;
      await pool.query(
        `INSERT INTO applications (id,client_id,name,client_secret_hash,redirect_uris) VALUES ($1,$2,$3,$4,$5)`,
        [appId, clientId, b.name, secret ? sha256(secret) : null, b.redirect_uris],
      );
      await audit({ actorId: req.admin!.userId, action: 'APP_REGISTERED', targetType: 'app', targetId: appId, appId, ip: req.ip });
      // Secret is shown exactly once.
      return reply.code(201).send({ id: appId, client_id: clientId, ...(secret ? { client_secret: secret } : {}) });
    });

    admin.delete('/v1/apps/:app', async (req, reply) => {
      const { app: rawApp } = req.params as { app: string };
      need(req, 'apps:manage');
      const appId = await resolveAppId(rawApp);
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
      const { app: rawApp } = req.params as { app: string };
      need(req, 'apps:manage');
      const appId = await resolveAppId(rawApp);
      if (appId === config.internalAppId) need(req, 'admin:all');
      const b = z.object({ permissions: z.array(z.object({ permission: z.string().regex(/^[a-z_]+:[a-z_]+$/), description: z.string().optional() })) }).parse(req.body);
      await tx(async (c) => {
        for (const p of b.permissions) {
          await c.query(`INSERT INTO app_resources (app_id,permission,description) VALUES ($1,$2,$3)
                         ON CONFLICT (app_id,permission) DO UPDATE SET description=EXCLUDED.description`, [appId, p.permission, p.description ?? null]);
        }
        await audit({ actorId: req.admin!.userId, action: 'PERMISSIONS_DEFINED', targetType: 'app', targetId: appId, appId, metadata: { count: b.permissions.length } }, c);
      });
      return reply.send({ ok: true });
    });

    admin.put('/v1/apps/:app/roles', async (req, reply) => {
      const { app: rawApp } = req.params as { app: string };
      need(req, 'apps:manage');
      const appId = await resolveAppId(rawApp);
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
          await c.query(
            `INSERT INTO app_roles (app_id, role, permissions, description, is_default, default_scope)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (app_id, role) DO UPDATE SET
               permissions = EXCLUDED.permissions,
               description = EXCLUDED.description,
               is_default = EXCLUDED.is_default,
               default_scope = EXCLUDED.default_scope`,
            [appId, r.role, r.permissions, r.description ?? null, r.is_default, r.default_scope],
          );
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
                a.client_id,
                p.permission,
                p.description,
                COALESCE((
                  SELECT json_agg(ar.role ORDER BY ar.role)
                  FROM app_roles ar
                  WHERE ar.app_id = p.app_id AND p.permission = ANY(ar.permissions)
                ), '[]') AS roles
         FROM app_resources p
         JOIN applications a ON a.id = p.app_id
         WHERE ($1::boolean = true OR p.app_id != $2)
         ORDER BY a.client_id, p.permission`,
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

      const appId = await resolveAppId(b.app_id);
      const app = (await pool.query(`SELECT id FROM applications WHERE id=$1`, [appId])).rows[0];
      if (!app) return reply.code(404).send({ error: 'app_not_found' });

      await tx(async (c) => {
        await c.query(
          `INSERT INTO app_resources (app_id, permission, description)
           VALUES ($1, $2, $3)
           ON CONFLICT (app_id, permission) DO UPDATE SET description = EXCLUDED.description`,
          [appId, b.permission, b.description ?? null],
        );
        await audit({
          actorId: req.admin!.userId,
          action: 'RESOURCE_CREATED',
          targetType: 'resource',
          targetId: `${appId}:${b.permission}`,
          appId,
          ip: req.ip,
          metadata: { permission: b.permission, description: b.description },
        }, c);
      });

      return reply.code(201).send({ ok: true });
    });

    admin.delete('/v1/resources/:app/:permission', async (req, reply) => {
      const { app: rawApp, permission } = req.params as { app: string; permission: string };
      need(req, 'apps:manage');
      const appId = await resolveAppId(rawApp);
      const removed = await tx(async (c) => {
        const r = await c.query(
          `DELETE FROM app_resources WHERE app_id = $1 AND permission = $2 RETURNING permission`,
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
      const { id, app: rawApp } = req.params as { id: string; app: string };
      const appId = await resolveAppId(rawApp);
      need(req, 'roles:assign', { app: appId, raw_app: rawApp });
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
      const { id, app: rawApp, assignmentId } = req.params as { id: string; app: string; assignmentId: string };
      const appId = await resolveAppId(rawApp);
      need(req, 'roles:assign', { app: appId, raw_app: rawApp });
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
      const apps = (await pool.query(`SELECT id,client_id,name FROM applications WHERE status='ACTIVE' ORDER BY id`)).rows;
      const assignments = (await pool.query(`SELECT id,app_id,role,scope,granted_by,granted_at,expires_at FROM user_app_roles WHERE user_id=$1`, [id])).rows;
      const out = [];
      for (const a of apps) {
        const eff = await resolveForApp(id, a.id);
        out.push({ app: a.client_id || a.id, app_id: a.id, name: a.name, role: eff.role, roles: eff.roles, permissions: eff.permissions, scope: eff.scope,
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
        `SELECT a.id,
                a.actor_id,
                a.action,
                a.target_type,
                a.target_id,
                COALESCE(app.client_id, a.app_id) AS app_id,
                a.metadata,
                a.ip,
                a.created_at,
                u_actor.email AS actor_email, u_actor.name AS actor_name,
                u_target.email AS target_email, u_target.name AS target_name
          FROM audit_logs a
          LEFT JOIN applications app ON app.id = a.app_id
          LEFT JOIN users u_actor ON a.actor_id = u_actor.id
          LEFT JOIN users u_target ON a.target_id = u_target.id
          WHERE ($1::text IS NULL OR a.actor_id=$1) AND ($2::text IS NULL OR a.target_id=$2)
            AND ($3::text IS NULL OR a.app_id=$3 OR app.client_id=$3)
            AND ($4::text IS NULL OR a.action=$4) AND ($5::timestamptz IS NULL OR a.created_at>=$5) AND ($6::timestamptz IS NULL OR a.created_at<=$6)
            AND ($7::text[] IS NULL OR a.app_id = ANY($7) OR app.client_id = ANY($7))
          ORDER BY a.created_at DESC, a.id DESC LIMIT $8`,
        [q.actor ?? null, q.target ?? null, q.app ?? null, q.action ?? null, q.from ?? null, q.to ?? null, apps, q.limit],
      );
      return { entries: r.rows };
    });

    // ---------------- Master Reference Data Admin Management ----------------
    admin.get('/v1/admin/master-data', async (req) => {
      need(req, 'admin:all');
      const [depts, degrees, branches, programs, terms, designations] = await Promise.all([
        pool.query(`
          SELECT d.code, d.name, d.status, d.created_at, d.updated_at,
                 COUNT(u.id)::int AS user_count
          FROM departments d
          LEFT JOIN users u ON u.dept_code = d.code
          GROUP BY d.code, d.name, d.status, d.created_at, d.updated_at
          ORDER BY d.name ASC
        `),
        pool.query(`
          SELECT deg.code, deg.name, deg.duration_years, deg.status, deg.created_at, deg.updated_at,
                 COUNT(DISTINCT p.id)::int AS program_count
          FROM degrees deg
          LEFT JOIN programs p ON p.degree_code = deg.code
          GROUP BY deg.code, deg.name, deg.duration_years, deg.status, deg.created_at, deg.updated_at
          ORDER BY deg.duration_years DESC NULLS LAST, deg.name ASC
        `),
        pool.query(`
          SELECT b.code, b.dept_code, d.name AS dept_name, b.name, b.status, b.created_at, b.updated_at,
                 COUNT(u.id)::int AS student_count
          FROM branches b
          JOIN departments d ON d.code = b.dept_code
          LEFT JOIN programs p ON p.branch_code = b.code
          LEFT JOIN users u ON u.program_id = p.id
          GROUP BY b.code, b.dept_code, d.name, b.name, b.status, b.created_at, b.updated_at
          ORDER BY b.dept_code ASC, b.name ASC
        `),
        pool.query(`
          SELECT p.id, p.degree_code, deg.name AS degree_name, deg.duration_years,
                 p.branch_code, b.name AS branch_name, b.dept_code, d.name AS dept_name,
                 p.status, p.created_at,
                 COUNT(u.id)::int AS student_count
          FROM programs p
          JOIN degrees deg ON deg.code = p.degree_code
          JOIN branches b ON b.code = p.branch_code
          JOIN departments d ON d.code = b.dept_code
          LEFT JOIN users u ON u.program_id = p.id
          GROUP BY p.id, p.degree_code, deg.name, deg.duration_years, p.branch_code, b.name, b.dept_code, d.name, p.status, p.created_at
          ORDER BY d.name ASC, b.name ASC
        `),
        pool.query(`
          SELECT code, name, start_date, end_date, is_current, created_at
          FROM academic_terms
          ORDER BY start_date DESC
        `),
        pool.query(`
          SELECT des.code, des.name, des.category, des.rank, des.status, des.created_at, des.updated_at,
                 COUNT(u.id)::int AS user_count
          FROM designations des
          LEFT JOIN users u ON u.designation_code = des.code
          GROUP BY des.code, des.name, des.category, des.rank, des.status, des.created_at, des.updated_at
          ORDER BY des.rank ASC, des.name ASC
        `),
      ]);

      return {
        departments: depts.rows,
        degrees: degrees.rows,
        branches: branches.rows,
        programs: programs.rows,
        terms: terms.rows,
        designations: designations.rows,
      };
    });

    admin.post('/v1/admin/departments', async (req, reply) => {
      need(req, 'admin:all');
      const b = z
        .object({
          code: z.string().regex(/^[A-Z0-9_]+$/).min(2).max(20),
          name: z.string().min(2),
        })
        .parse(req.body);

      await pool.query(
        `INSERT INTO departments (code, name, status) VALUES ($1, $2, 'ACTIVE')
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, status = 'ACTIVE', updated_at = now()`,
        [b.code, b.name],
      );

      await audit({
        actorId: req.admin!.userId,
        action: 'DEPARTMENT_CREATED',
        targetType: 'department',
        targetId: b.code,
        metadata: { name: b.name },
        ip: req.ip,
      });

      return reply.code(201).send({ ok: true, code: b.code });
    });

    admin.patch('/v1/admin/departments/:code', async (req) => {
      need(req, 'admin:all');
      const { code } = req.params as { code: string };
      const b = z
        .object({
          name: z.string().min(2).optional(),
          status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
        })
        .parse(req.body);

      await pool.query(
        `UPDATE departments
         SET name = COALESCE($2, name),
             status = COALESCE($3, status),
             updated_at = now()
         WHERE code = $1`,
        [code, b.name ?? null, b.status ?? null],
      );

      await audit({
        actorId: req.admin!.userId,
        action: 'DEPARTMENT_UPDATED',
        targetType: 'department',
        targetId: code,
        metadata: b,
        ip: req.ip,
      });

      return { ok: true, code };
    });

    admin.post('/v1/admin/branches', async (req, reply) => {
      need(req, 'admin:all');
      const b = z
        .object({
          code: z.string().regex(/^[A-Z0-9_]+$/).min(2).max(20),
          dept_code: z.string().min(2),
          name: z.string().min(2),
        })
        .parse(req.body);

      await pool.query(
        `INSERT INTO branches (code, dept_code, name, status) VALUES ($1, $2, $3, 'ACTIVE')
         ON CONFLICT (code) DO UPDATE SET dept_code = EXCLUDED.dept_code, name = EXCLUDED.name, status = 'ACTIVE', updated_at = now()`,
        [b.code, b.dept_code, b.name],
      );

      await audit({
        actorId: req.admin!.userId,
        action: 'BRANCH_CREATED',
        targetType: 'branch',
        targetId: b.code,
        metadata: { dept_code: b.dept_code, name: b.name },
        ip: req.ip,
      });

      return reply.code(201).send({ ok: true, code: b.code });
    });

    admin.patch('/v1/admin/branches/:code', async (req) => {
      need(req, 'admin:all');
      const { code } = req.params as { code: string };
      const b = z
        .object({
          name: z.string().min(2).optional(),
          dept_code: z.string().optional(),
          status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
        })
        .parse(req.body);

      await pool.query(
        `UPDATE branches
         SET name = COALESCE($2, name),
             dept_code = COALESCE($3, dept_code),
             status = COALESCE($4, status),
             updated_at = now()
         WHERE code = $1`,
        [code, b.name ?? null, b.dept_code ?? null, b.status ?? null],
      );

      await audit({
        actorId: req.admin!.userId,
        action: 'BRANCH_UPDATED',
        targetType: 'branch',
        targetId: code,
        metadata: b,
        ip: req.ip,
      });

      return { ok: true, code };
    });

    admin.post('/v1/admin/terms', async (req, reply) => {
      need(req, 'admin:all');
      const b = z
        .object({
          code: z.string().regex(/^[A-Z0-9_-]+$/).min(3),
          name: z.string().min(3),
          start_date: z.string(),
          end_date: z.string(),
          is_current: z.boolean().default(false),
        })
        .parse(req.body);

      await tx(async (c) => {
        if (b.is_current) {
          await c.query(`UPDATE academic_terms SET is_current = false WHERE is_current = true`);
        }
        await c.query(
          `INSERT INTO academic_terms (code, name, start_date, end_date, is_current)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (code) DO UPDATE SET
             name = EXCLUDED.name,
             start_date = EXCLUDED.start_date,
             end_date = EXCLUDED.end_date,
             is_current = EXCLUDED.is_current`,
          [b.code, b.name, b.start_date, b.end_date, b.is_current],
        );
      });

      await audit({
        actorId: req.admin!.userId,
        action: 'ACADEMIC_TERM_SAVED',
        targetType: 'term',
        targetId: b.code,
        metadata: b,
        ip: req.ip,
      });

      return reply.code(201).send({ ok: true, code: b.code });
    });

    admin.patch('/v1/admin/terms/:code/activate', async (req) => {
      need(req, 'admin:all');
      const { code } = req.params as { code: string };

      await tx(async (c) => {
        await c.query(`UPDATE academic_terms SET is_current = false WHERE is_current = true`);
        const r = await c.query(
          `UPDATE academic_terms SET is_current = true WHERE code = $1 RETURNING code`,
          [code],
        );
        if (r.rowCount === 0) {
          throw new HttpError(404, `Term ${code} not found`);
        }
      });

      await audit({
        actorId: req.admin!.userId,
        action: 'ACADEMIC_TERM_ACTIVATED',
        targetType: 'term',
        targetId: code,
        ip: req.ip,
      });

      return { ok: true, active_term: code };
    });

    admin.post('/v1/admin/designations', async (req, reply) => {
      need(req, 'admin:all');
      const b = z
        .object({
          code: z.string().regex(/^[A-Z0-9_]+$/).min(2),
          name: z.string().min(2),
          category: z.enum(['FACULTY', 'STAFF']),
          rank: z.number().int().default(100),
        })
        .parse(req.body);

      await pool.query(
        `INSERT INTO designations (code, name, category, rank, status) VALUES ($1, $2, $3, $4, 'ACTIVE')
         ON CONFLICT (code) DO UPDATE SET
           name = EXCLUDED.name,
           category = EXCLUDED.category,
           rank = EXCLUDED.rank,
           status = 'ACTIVE',
           updated_at = now()`,
        [b.code, b.name, b.category, b.rank],
      );

      await audit({
        actorId: req.admin!.userId,
        action: 'DESIGNATION_CREATED',
        targetType: 'designation',
        targetId: b.code,
        metadata: b,
        ip: req.ip,
      });

      return reply.code(201).send({ ok: true, code: b.code });
    });

    admin.patch('/v1/admin/designations/:code', async (req) => {
      need(req, 'admin:all');
      const { code } = req.params as { code: string };
      const b = z
        .object({
          name: z.string().min(2).optional(),
          category: z.enum(['FACULTY', 'STAFF']).optional(),
          rank: z.number().int().optional(),
          status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
        })
        .parse(req.body);

      await pool.query(
        `UPDATE designations
         SET name = COALESCE($2, name),
             category = COALESCE($3, category),
             rank = COALESCE($4, rank),
             status = COALESCE($5, status),
             updated_at = now()
         WHERE code = $1`,
        [code, b.name ?? null, b.category ?? null, b.rank ?? null, b.status ?? null],
      );

      await audit({
        actorId: req.admin!.userId,
        action: 'DESIGNATION_UPDATED',
        targetType: 'designation',
        targetId: code,
        metadata: b,
        ip: req.ip,
      });

      return { ok: true, code };
    });
  });
}

async function publishAndRevokeCache(userId: string) {
  await publishAclVersion(userId);
}
