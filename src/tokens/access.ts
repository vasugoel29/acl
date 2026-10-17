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
  branch?: string | null;
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
  const u = (await pool.query(`SELECT * FROM users WHERE id=$1`, [userId])).rows[0];
  if (!u) return null;
  return {
    roll_no: u.roll_no ?? null,
    twelve_digit_roll_no: includeSensitivePii && u.twelve_digit_roll_no ? String(u.twelve_digit_roll_no) : null,
    degree: u.degree ?? null,
    dept: u.dept ?? null,
    branch: u.branch ?? null,
    year: u.year ?? null,
    semester: u.semester ?? null,
    section: u.section ?? null,
    group: u.group_no ?? null,
    group_no: u.group_no ?? null,
    batch_no: u.batch_no ?? null,
    batch_year: u.batch_year ?? null,
    employee_id: u.employee_id ?? null,
    designation: u.designation ?? null,
    mobile_no: includeSensitivePii ? (u.mobile_no ?? null) : null,
  };
}

/** Standard response contract (spec §2.4). */
export async function buildUserInfo(user: UserRow, appId: string) {
  const [access, academic] = await Promise.all([resolveForApp(user.id, appId), academicOf(user.id)]);
  return {
    user: { id: user.id, name: user.name, email: user.email, ...(academic ? { academic } : {}) },
    app: appId,
    role: access.role,
    roles: access.roles,
    permissions: access.permissions,
    allowed_scope: access.scope,
    scopes_by_permission: access.scopes_by_permission,
  };
}

export async function issueAccessToken(user: UserRow, appId: string) {
  const access = await resolveForApp(user.id, appId);
  const ver = user.acl_version ?? 1;
  const token = await signJwt(
    {
      token_use: 'access',
      email: user.email,
      role: access.role,
      roles: access.roles,
      permissions: access.permissions,
      scope: access.scope,
      ver,
    },
    { aud: appId, sub: user.id, ttlSec: config.accessTokenTtlSec },
  );
  return { token, expiresIn: config.accessTokenTtlSec };
}

export async function issueIdToken(user: UserRow, appId: string, nonce?: string | null) {
  return signJwt(
    { token_use: 'id', name: user.name, email: user.email, email_verified: true, ...(nonce ? { nonce } : {}) },
    { aud: appId, sub: user.id, ttlSec: 600 },
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
