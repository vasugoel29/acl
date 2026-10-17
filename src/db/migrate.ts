import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const candidateCwd = path.resolve(process.cwd(), 'migrations');
const dir = fs.existsSync(candidateCwd)
  ? candidateCwd
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
const MIGRATION_ADVISORY_LOCK_ID = 72839101;

export async function migrate() {
  const lockClient = await pool.connect();
  try {
    await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_ID]);
    await lockClient.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`,
    );
    const done = new Set((await lockClient.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      try {
        await lockClient.query('BEGIN');
        await lockClient.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await lockClient.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await lockClient.query('COMMIT');
        console.log('applied', f);
      } catch (e) {
        await lockClient.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_ID]).catch(() => {});
    lockClient.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate().then(() => pool.end());
}
