import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { newId, randomToken, sha256 } from '../util.js';
import { audit } from '../audit.js';

export async function createSession(opts: { userId: string; appId: string; userAgent?: string; ip?: string }) {
  const refresh = randomToken(48);
  const id = newId('ses');
  await pool.query(
    `INSERT INTO sessions (id,user_id,app_id,refresh_hash,family_id,user_agent,ip,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' seconds')::interval)`,
    [id, opts.userId, opts.appId, sha256(refresh), newId('fam'), opts.userAgent ?? null, opts.ip ?? null, String(config.refreshTokenTtlSec)],
  );
  return { sessionId: id, refresh };
}

export type RotateResult =
  | { ok: true; userId: string; appId: string; refresh: string }
  | { ok: false; reason: 'invalid' | 'reuse' | 'expired' };

/**
 * Rotate on use. A previously-rotated (revoked) token being replayed means theft:
 * revoke the whole family (spec §2.3 reuse detection).
 */
export async function rotateRefresh(token: string, appId: string): Promise<RotateResult> {
  const h = sha256(token);
  const row = (await pool.query(`SELECT * FROM sessions WHERE refresh_hash=$1`, [h])).rows[0];
  if (!row || row.app_id !== appId) return { ok: false, reason: 'invalid' };
  if (row.revoked_at) {
    await pool.query(`UPDATE sessions SET revoked_at = now() WHERE family_id=$1 AND revoked_at IS NULL`, [row.family_id]);
    await audit({ actorId: row.user_id, action: 'REFRESH_REUSE_DETECTED', targetType: 'session', targetId: row.id, appId });
    return { ok: false, reason: 'reuse' };
  }
  if (new Date(row.expires_at) < new Date()) return { ok: false, reason: 'expired' };

  // Atomic claim so two concurrent refreshes can't both succeed.
  const claimed = await pool.query(`UPDATE sessions SET revoked_at = now() WHERE id=$1 AND revoked_at IS NULL RETURNING id`, [row.id]);
  if (!claimed.rowCount) return { ok: false, reason: 'reuse' };

  const next = randomToken(48);
  await pool.query(
    `INSERT INTO sessions (id,user_id,app_id,refresh_hash,family_id,user_agent,ip,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [newId('ses'), row.user_id, row.app_id, sha256(next), row.family_id, row.user_agent, row.ip, row.expires_at],
  );
  return { ok: true, userId: row.user_id, appId: row.app_id, refresh: next };
}

export async function revokeRefresh(token: string) {
  const row = (await pool.query(`SELECT family_id FROM sessions WHERE refresh_hash=$1`, [sha256(token)])).rows[0];
  if (row) await pool.query(`UPDATE sessions SET revoked_at = now() WHERE family_id=$1 AND revoked_at IS NULL`, [row.family_id]);
}

export async function revokeAllForUser(userId: string, appId?: string) {
  await pool.query(
    `UPDATE sessions SET revoked_at = now() WHERE user_id=$1 AND revoked_at IS NULL AND ($2::text IS NULL OR app_id=$2)`,
    [userId, appId ?? null],
  );
}
