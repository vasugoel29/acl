export default async function setup() {
  process.env.DATABASE_URL = 'postgres://acl:acl@localhost:5433/acl_test';
  process.env.REDIS_URL = 'redis://localhost:6379/1';
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'root@nsut.ac.in';
  process.env.NODE_ENV = 'test';

  const { pool } = await import('../src/db/pool.js');
  const { migrate } = await import('../src/db/migrate.js');
  const { seed } = await import('../src/db/seed.js');
  const { redis } = await import('../src/redis.js');

  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await redis.flushdb();
    await migrate();
    await seed();
  } finally {
    await pool.end().catch(() => {});
    redis.disconnect();
  }
}
