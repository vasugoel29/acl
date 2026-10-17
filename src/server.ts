import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { config, isProd, validateProdConfig } from './config.js';
import { oidcRoutes } from './routes/oidc.js';
import { adminRoutes, registerErrorHandler } from './routes/admin.js';
import { pool } from './db/pool.js';
import { redis } from './redis.js';

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? true, trustProxy: config.trustProxy });

  registerErrorHandler(app);

  // Enterprise HTTP security headers (HSTS, CSP, clickjacking, MIME sniffing)
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    reply.header(
      'content-security-policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (isProd) {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
  });

  await app.register(cookie, {
    secret: config.cookieSecret,
    hook: 'onRequest',
  });

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  app.addContentTypeParser('text/csv', { parseAs: 'string', bodyLimit: 50 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  // NAT-aware rate limiting: key by session/token fingerprint + IP so shared campus NAT IPs don't throttle all students
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
  });

  // Allow credentials (cookies) and CSRF custom header from Admin Console
  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  });

  app.get('/livez', async () => ({ status: 'alive' }));

  const readinessHandler = async () => {
    await pool.query('SELECT 1');
    await redis.ping();
    return { ok: true };
  };
  app.get('/healthz', readinessHandler);
  app.get('/readyz', readinessHandler);


  await app.register(oidcRoutes);
  await app.register(adminRoutes);
  return app;
}

const isMain = process.argv[1] && (process.argv[1] === fileURLToPath(import.meta.url) || process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'));

if (isMain) {
  validateProdConfig();
  try {
    const { migrate } = await import('./db/migrate.js');
    const { seed } = await import('./db/seed.js');
    await migrate();
    await seed();
  } catch (err) {
    console.error('Fatal: database migration/seed failed on startup:', err);
    process.exit(1);
  }
  const app = await buildApp();
  let worker: Awaited<ReturnType<typeof import('./jobs/queue.js')['startWorker']>> | null = null;
  if (process.env.INLINE_WORKER !== 'false') {
    const { startWorker } = await import('./jobs/queue.js');
    worker = startWorker();
  }
  await app.listen({ port: config.port, host: '0.0.0.0' });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Shutting down gracefully...');
    try {
      await app.close();
      if (worker) await worker.close();
      await pool.end();
      redis.disconnect();
      process.exit(0);
    } catch (err) {
      app.log.error(err, 'Error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
