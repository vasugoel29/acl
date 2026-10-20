import 'dotenv/config';

const env = process.env;
const nodeEnv = env.NODE_ENV ?? 'development';
export const isProd = nodeEnv === 'production';
export const isServerless = Boolean(env.VERCEL || env.SERVERLESS === 'true');

const vercelDefaultUrl = env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`
  : env.VERCEL_URL
    ? `https://${env.VERCEL_URL}`
    : undefined;

const DEFAULT_COOKIE_SECRET = 'nsut-acl-super-secure-cookie-secret-min-32-chars-long!';
const corsOrigins = (env.CORS_ORIGINS ?? vercelDefaultUrl ?? 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

function parseTrustProxy(val: string | undefined): boolean | string | string[] {
  if (!val) {
    if (isServerless) return true;
    // In self-hosted production default to loopback and RFC1918 private network CIDRs behind campus reverse proxy
    return isProd ? ['127.0.0.1', '::1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'] : true;
  }
  if (val === 'true') return true;
  if (val === 'false') return false;
  return val.split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  nodeEnv,
  port: Number(env.PORT ?? 4000),
  issuer: (env.ISSUER ?? vercelDefaultUrl ?? 'http://localhost:4000').replace(/\/$/, ''),
  consoleUrl: (env.CONSOLE_URL ?? corsOrigins[0] ?? 'http://localhost:5173').replace(/\/$/, ''),
  corsOrigins,
  trustProxy: parseTrustProxy(env.TRUST_PROXY),
  databaseUrl: env.DATABASE_URL ?? 'postgres://acl:acl@localhost:5433/acl',
  redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
  allowedDomain: (env.ALLOWED_DOMAIN ?? 'nsut.ac.in').trim().toLowerCase(),
  allowedDomains: (env.ALLOWED_DOMAINS ?? 'nsut.ac.in,nsit.ac.in')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
  cookieSecret: env.COOKIE_SECRET ?? DEFAULT_COOKIE_SECRET,
  google: {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
  },
  accessTokenTtlSec: Number(env.ACCESS_TOKEN_TTL_SEC ?? 15 * 60),
  refreshTokenTtlSec: Number(env.REFRESH_TOKEN_TTL_SEC ?? 30 * 24 * 3600),
  adminSessionTtlSec: Number(env.ADMIN_SESSION_TTL_SEC ?? 8 * 3600),
  authCodeTtlSec: 120,
  keysFile: env.KEYS_FILE ?? 'keys/signing.json',
  signingKeysJson: env.SIGNING_KEYS_JSON,
  cronSecret: env.CRON_SECRET,
  bootstrapAdminEmail: env.BOOTSTRAP_ADMIN_EMAIL,
  internalAppId: env.INTERNAL_APP_ID ?? 'app_01JACL00000000000000000000',
  internalClientSlug: 'ACL',
  enableRateLimit: env.ENABLE_RATE_LIMIT !== 'false' && env.RATE_LIMIT_DISABLED !== 'true',
  rateLimitMax: Number(env.RATE_LIMIT_MAX ?? 5000),
};

/** Validate required security settings before starting in production. */
export function validateProdConfig() {
  if (!isProd) return;
  const errors: string[] = [];

  if (!config.issuer.startsWith('https://') || config.issuer.includes('localhost')) {
    errors.push('ISSUER must be an explicit https:// URL in production');
  }
  if (!env.COOKIE_SECRET || config.cookieSecret === DEFAULT_COOKIE_SECRET || config.cookieSecret.length < 32) {
    errors.push('COOKIE_SECRET must be explicitly set to a random secret of at least 32 characters in production');
  }
  if (!env.DATABASE_URL || config.databaseUrl.includes('acl:acl@localhost')) {
    errors.push('DATABASE_URL must be explicitly configured with non-default credentials in production');
  }
  if (!env.REDIS_URL) {
    errors.push('REDIS_URL must be explicitly configured in production');
  }
  if (!config.google.clientId || !config.google.clientSecret) {
    errors.push('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required in production');
  }
  if (config.corsOrigins.length === 0 || config.corsOrigins.some((o) => o.includes('localhost'))) {
    errors.push('CORS_ORIGINS must be explicitly set to non-localhost origins in production');
  }

  if (errors.length > 0) {
    throw new Error(`Production configuration validation failed:\n  - ${errors.join('\n  - ')}`);
  }
}

if (isProd) {
  validateProdConfig();
}
