import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { redis, keys } from '../redis.js';
import { resolveForApp } from '../acl/engine.js';
import { signJwt } from './jwt.js';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  status: string;
  avatar_url: string | null;
  dept?: string | null;
  dept_code?: string | null;
  branch?: string | null;
  program_id?: number | null;
  degree?: string | null;
  roll_no?: string | null;
  twelve_digit_roll_no?: string | null;
  year?: number | null;
  semester?: number | null;
  section?: number | null;
  group_no?: number | null;
  batch_no?: number | null;
  batch_year?: number | null;
  employee_id?: string | null;
  designation?: string | null;
  designation_code?: string | null;
  mobile_no?: string | null;
  acl_version?: number | null;
  google_sub?: string | null;
  created_at?: Date;
  updated_at?: Date;
}

export async function getUser(id: string): Promise<UserRow | null> {
  const r = await pool.query(`SELECT * FROM users WHERE id=$1`, [id]);
  return r.rows[0] ?? null;
}

/** Strip internal fields (google_sub) and optionally redact sensitive PII for scoped viewers. */
export function sanitizeUser(u: UserRow, includeSensitivePii = true) {
  const { google_sub: _gsub, ...safe } = u;
  if (!includeSensitivePii) {
    return {
      ...safe,
      mobile_no: null,
      twelve_digit_roll_no: null,
    };
  }
  return safe;
}

export async function academicOf(userId: string, includeSensitivePii = true) {
  const r = await pool.query(
    `SELECT u.*,
            d.name AS master_dept_name,
            p.branch_code,
            p.degree_code,
            b.name AS master_branch_name,
            deg.name AS master_degree_name,
            des.name AS master_desig_name
     FROM users u
     LEFT JOIN departments d ON d.code = u.dept_code
     LEFT JOIN programs p ON p.id = u.program_id
     LEFT JOIN branches b ON b.code = p.branch_code
     LEFT JOIN degrees deg ON deg.code = p.degree_code
     LEFT JOIN designations des ON des.code = u.designation_code
     WHERE u.id = $1`,
    [userId],
  );
  const u = r.rows[0];
  if (!u) return null;
  return {
    roll_no: u.roll_no ?? null,
    twelve_digit_roll_no: includeSensitivePii && u.twelve_digit_roll_no ? String(u.twelve_digit_roll_no) : null,
    dept_code: u.dept_code ?? null,
    program_id: u.program_id ?? null,
    branch_code: u.branch_code ?? null,
    degree_code: u.degree_code ?? null,
    designation_code: u.designation_code ?? null,
    degree: u.master_degree_name ?? u.degree ?? null,
    dept: u.master_dept_name ?? u.dept ?? null,
    branch: u.master_branch_name ?? u.branch ?? null,
    year: u.year ?? null,
    semester: u.semester ?? null,
    section: u.section ?? null,
    group: u.group_no ?? null,
    group_no: u.group_no ?? null,
    batch_no: u.batch_no ?? null,
    batch_year: u.batch_year ?? null,
    employee_id: u.employee_id ?? null,
    designation: u.master_desig_name ?? u.designation ?? null,
    mobile_no: includeSensitivePii ? (u.mobile_no ?? null) : null,
  };
}

/** Standard response contract (spec §2.4). */
export async function buildUserInfo(user: UserRow, appId: string) {
  let displayApp = appId;
  if (appId.startsWith('app_')) {
    const row = (await pool.query(`SELECT client_id FROM applications WHERE id = $1`, [appId])).rows[0];
    if (row?.client_id) displayApp = row.client_id;
  }
  const [access, academic] = await Promise.all([resolveForApp(user.id, appId), academicOf(user.id)]);
  return {
    user: { id: user.id, name: user.name, email: user.email, ...(academic ? { academic } : {}) },
    app: displayApp,
    app_id: appId,
    role: access.role,
    roles: access.roles,
    permissions: access.permissions,
    allowed_scope: access.scope,
    scopes_by_permission: access.scopes_by_permission,
  };
}

export async function issueAccessToken(user: UserRow, appId: string, clientSlug?: string) {
  const access = await resolveForApp(user.id, appId);
  const ver = user.acl_version ?? 1;
  const aud = clientSlug ?? appId;
  const token = await signJwt(
    {
      token_use: 'access',
      email: user.email,
      role: access.role,
      roles: access.roles,
      permissions: access.permissions,
      scope: access.scope,
      app_id: appId,
      client_id: clientSlug ?? appId,
      ver,
    },
    { aud, sub: user.id, ttlSec: config.accessTokenTtlSec },
  );
  return { token, expiresIn: config.accessTokenTtlSec };
}

export async function issueIdToken(user: UserRow, appId: string, nonce?: string | null, clientSlug?: string) {
  const aud = clientSlug ?? appId;
  return signJwt(
    { token_use: 'id', name: user.name, email: user.email, email_verified: true, ...(nonce ? { nonce } : {}) },
    { aud, sub: user.id, ttlSec: 600 },
  );
}

export async function publishAclVersion(userId: string, ver?: number) {
  if (ver !== undefined) {
    await redis.set(keys.aclVersion(userId), String(ver), 'EX', config.accessTokenTtlSec * 2);
  } else {
    await redis.del(keys.aclVersion(userId));
  }
}

export async function denyJti(jti: string, ttlSec: number) {
  await redis.set(keys.denyJti(jti), '1', 'EX', Math.max(ttlSec, 1));
}

export async function denyUserTokens(userId: string, ttlSec = config.accessTokenTtlSec) {
  const revokedAt = Math.floor(Date.now() / 1000);
  await redis.set(keys.denyUser(userId), String(revokedAt), 'EX', Math.max(ttlSec, 1));
}

export async function clearUserDeny(userId: string) {
  await redis.del(keys.denyUser(userId));
}
