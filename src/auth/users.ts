import { pool, type Queryable } from '../db/pool.js';
import { newId } from '../util.js';
import { audit } from '../audit.js';
import { DomainError, type GoogleIdentity } from './google.js';

const ROLL_RE = /^(\d{4})[a-z]{3}\d{3,5}$/i;

/** Find by google_sub, then by email; otherwise auto-provision (spec Flow 2). */
export async function upsertFromGoogle(g: GoogleIdentity, ip?: string) {
  const existing = (
    await pool.query(`SELECT * FROM users WHERE google_sub=$1 OR email=$2 ORDER BY (google_sub=$1) DESC LIMIT 1`, [g.sub, g.email])
  ).rows[0];

  if (existing) {
    if (existing.google_sub && existing.google_sub !== g.sub) {
      // Allow seamless cutover when an existing dev/seeded account has a mock-* sub
      if (String(existing.google_sub).startsWith('mock-') && !g.sub.startsWith('mock-')) {
        await audit({
          actorId: existing.id,
          action: 'USER_SUB_UPGRADED',
          targetType: 'user',
          targetId: existing.id,
          ip,
        });
      } else {
        throw new DomainError('google sub mismatch for existing email');
      }
    }
    const r = await pool.query(
      `UPDATE users SET google_sub=$2, avatar_url=COALESCE($3, avatar_url), updated_at=now() WHERE id=$1 RETURNING *`,
      [existing.id, g.sub, g.picture ?? null],
    );
    return { user: r.rows[0], created: false };
  }

  // Provision minimal user with status='ACTIVE' and conflict-safe upsert against concurrent first logins.
  const id = newId('usr');
  const r = await pool.query(
    `INSERT INTO users (id,email,google_sub,name,avatar_url) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (email) DO UPDATE
       SET google_sub = COALESCE(users.google_sub, EXCLUDED.google_sub),
           avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
           updated_at = now()
     RETURNING *`,
    [id, g.email, g.sub, g.name, g.picture ?? null],
  );
  const created = r.rows[0].id === id;
  if (created) {
    await audit({ actorId: id, action: 'USER_PROVISIONED', targetType: 'user', targetId: id, ip, metadata: { via: 'google_login' } });
  }
  return { user: r.rows[0], created };
}

export function looksLikeRollNo(local: string) {
  return ROLL_RE.test(local);
}

export async function appById(id: string, db: Queryable = pool) {
  return (await db.query(`SELECT * FROM applications WHERE id=$1 AND status='ACTIVE'`, [id])).rows[0] ?? null;
}
