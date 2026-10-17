import type { Queryable } from './db/pool.js';
import { pool } from './db/pool.js';

export interface AuditEntry {
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  appId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
}

export async function audit(e: AuditEntry, db: Queryable = pool) {
  await db.query(
    `INSERT INTO audit_logs (actor_id, action, target_type, target_id, app_id, metadata, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [e.actorId ?? null, e.action, e.targetType ?? null, e.targetId ?? null, e.appId ?? null, e.metadata ?? null, e.ip ?? null],
  );
}
