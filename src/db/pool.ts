import pg from 'pg';
import { config, isServerless } from '../config.js';

const needsSsl =
  process.env.DB_SSL === 'true' ||
  config.databaseUrl.includes('supabase.co') ||
  config.databaseUrl.includes('supabase.com') ||
  config.databaseUrl.includes('neon.tech') ||
  config.databaseUrl.includes('sslmode=require');

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  ...(isServerless ? { max: 5, idleTimeoutMillis: 10000 } : {}),
});

export type Queryable = Pick<pg.Pool, 'query'>;

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
