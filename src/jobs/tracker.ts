import { pool } from '../db/pool.js';

export interface IngestionJobRecord {
  id: string;
  type: 'IMPORT' | 'EXPORT' | 'ROLLOVER';
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  actor_id?: string | null;
  actor_email?: string | null;
  filename?: string | null;
  total_rows: number;
  processed_rows: number;
  created_count: number;
  updated_count: number;
  failed_count: number;
  progress_pct: number;
  error_message?: string | null;
  metadata?: Record<string, any>;
  started_at?: Date | null;
  completed_at?: Date | null;
  created_at: Date;
}

export async function createJobRecord(params: {
  id: string;
  type: 'IMPORT' | 'EXPORT' | 'ROLLOVER';
  actorId?: string | null;
  actorEmail?: string | null;
  filename?: string | null;
  totalRows?: number;
  metadata?: Record<string, any>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO ingestion_jobs (
      id, type, status, actor_id, actor_email, filename, total_rows, metadata
    ) VALUES ($1, $2, 'QUEUED', $3, $4, $5, $6, $7)`,
    [
      params.id,
      params.type,
      params.actorId ?? null,
      params.actorEmail ?? null,
      params.filename ?? null,
      params.totalRows ?? 0,
      JSON.stringify(params.metadata ?? {}),
    ],
  );
}

export async function startJobRecord(id: string, totalRows?: number, type: 'IMPORT' | 'EXPORT' | 'ROLLOVER' = 'IMPORT'): Promise<void> {
  await pool.query(
    `INSERT INTO ingestion_jobs (id, type, status, started_at, total_rows)
     VALUES ($1, $3, 'PROCESSING', now(), COALESCE($2, 0))
     ON CONFLICT (id) DO UPDATE
     SET status = 'PROCESSING',
         started_at = COALESCE(ingestion_jobs.started_at, now()),
         total_rows = CASE WHEN $2 IS NOT NULL AND $2 > 0 THEN $2 ELSE ingestion_jobs.total_rows END`,
    [id, totalRows ?? null, type],
  );
}

export async function updateJobProgress(params: {
  id: string;
  processedRows: number;
  totalRows?: number;
  createdCount?: number;
  updatedCount?: number;
  failedCount?: number;
  progressPct?: number;
  metadata?: Record<string, any>;
}): Promise<void> {
  const pct = params.progressPct !== undefined
    ? params.progressPct
    : params.totalRows && params.totalRows > 0
      ? Math.min(100, Math.round((params.processedRows / params.totalRows) * 100))
      : 0;

  await pool.query(
    `UPDATE ingestion_jobs
     SET status = 'PROCESSING',
         started_at = COALESCE(started_at, now()),
         processed_rows = $2,
         total_rows = COALESCE($3, total_rows),
         created_count = COALESCE($4, created_count),
         updated_count = COALESCE($5, updated_count),
         failed_count = COALESCE($6, failed_count),
         progress_pct = $7,
         metadata = CASE WHEN $8::jsonb IS NOT NULL THEN metadata || $8::jsonb ELSE metadata END
     WHERE id = $1`,
    [
      params.id,
      params.processedRows,
      params.totalRows ?? null,
      params.createdCount ?? null,
      params.updatedCount ?? null,
      params.failedCount ?? null,
      pct,
      params.metadata ? JSON.stringify(params.metadata) : null,
    ],
  );
}

export async function completeJobRecord(params: {
  id: string;
  totalRows?: number;
  processedRows?: number;
  createdCount?: number;
  updatedCount?: number;
  failedCount?: number;
  metadata?: Record<string, any>;
}): Promise<void> {
  await pool.query(
    `UPDATE ingestion_jobs
     SET status = 'COMPLETED',
         progress_pct = 100,
         completed_at = now(),
         total_rows = COALESCE($2, total_rows),
         processed_rows = COALESCE($3, processed_rows),
         created_count = COALESCE($4, created_count),
         updated_count = COALESCE($5, updated_count),
         failed_count = COALESCE($6, failed_count),
         metadata = CASE WHEN $7::jsonb IS NOT NULL THEN metadata || $7::jsonb ELSE metadata END
     WHERE id = $1`,
    [
      params.id,
      params.totalRows ?? null,
      params.processedRows ?? null,
      params.createdCount ?? null,
      params.updatedCount ?? null,
      params.failedCount ?? null,
      params.metadata ? JSON.stringify(params.metadata) : null,
    ],
  );
}

export async function failJobRecord(id: string, errorMessage: string): Promise<void> {
  await pool.query(
    `UPDATE ingestion_jobs
     SET status = 'FAILED',
         error_message = $2,
         completed_at = now()
     WHERE id = $1`,
    [id, errorMessage],
  );
}

export async function listJobs(limit = 50, offset = 0): Promise<IngestionJobRecord[]> {
  const r = await pool.query(
    `SELECT * FROM ingestion_jobs ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return r.rows;
}

export async function getJobRecord(id: string): Promise<IngestionJobRecord | null> {
  const r = await pool.query(`SELECT * FROM ingestion_jobs WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}
