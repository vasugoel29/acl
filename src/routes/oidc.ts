import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config, isProd } from '../config.js';
import { pool } from '../db/pool.js';
import { redis, keys } from '../redis.js';
import { randomToken, safeCompareHex, sha256 } from '../util.js';
import { audit } from '../audit.js';
import { jwks, verifyJwt } from '../tokens/jwt.js';
import { buildUserInfo, clearUserDeny, getUser, issueAccessToken, issueIdToken, denyJti } from '../tokens/access.js';
import { createSession, revokeAllForUser, revokeRefresh, rotateRefresh } from '../tokens/refresh.js';
import { DomainError, googleAuthUrl, googleExchange, pkce } from '../auth/google.js';
import { appById, upsertFromGoogle } from '../auth/users.js';

const callbackUrl = () => `${config.issuer}/auth/google/callback`;

function redirectWith(base: string, params: Record<string, string | undefined>) {
  const u = new URL(base);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error('Invalid redirect URI protocol');
  }
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

function oauthError(reply: any, status: number, error: string, description?: string) {
  return reply.code(status).send({ error, error_description: description });
}

/** Client authentication: public clients (no secret on file) rely on PKCE; confidential ones must present the secret. */
async function authenticateClient(req: FastifyRequest, clientId?: string, secret?: string) {
  let id = clientId;
  let sec = secret;
  const basic = req.headers.authorization?.startsWith('Basic ') ? req.headers.authorization.slice(6) : null;
  if (basic) {
    const [bid, bsec] = Buffer.from(basic, 'base64').toString().split(':');
    id = bid;
    sec = bsec;
  }
  if (!id) return null;
  const app = await appById(id);
  if (!app) return null;
  if (app.client_secret_hash && (!sec || !safeCompareHex(sha256(sec), app.client_secret_hash))) return null;
  return { app, authenticated: !!app.client_secret_hash };
}

function bearer(req: FastifyRequest) {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : null;
}

export async function oidcRoutes(app: FastifyInstance) {
  app.get('/.well-known/openid-configuration', async () => ({
    issuer: config.issuer,
    authorization_endpoint: `${config.issuer}/authorize`,
    token_endpoint: `${config.issuer}/token`,
    userinfo_endpoint: `${config.issuer}/userinfo`,
    introspection_endpoint: `${config.issuer}/introspect`,
    revocation_endpoint: `${config.issuer}/revoke`,
    end_session_endpoint: `${config.issuer}/logout`,
    jwks_uri: `${config.issuer}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    id_token_signing_alg_values_supported: ['ES256'],
    subject_types_supported: ['public'],
    scopes_supported: ['openid', 'email', 'profile'],
  }));

  app.get('/.well-known/jwks.json', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return jwks();
  });

  // ---- /authorize ----
  app.get('/authorize', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const client = q.client_id ? await appById(q.client_id) : null;
    // Never redirect to an unvalidated URI: exact-match only.
    if (!client || !q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) {
      return oauthError(reply, 400, 'invalid_request', 'unknown client_id or redirect_uri mismatch');
    }
    const fail = (error: string) => reply.redirect(redirectWith(q.redirect_uri, { error, state: q.state }));
    if (q.response_type !== 'code') return fail('unsupported_response_type');
    if (!q.code_challenge || q.code_challenge_method !== 'S256') return fail('invalid_request');
    if (!q.state) return fail('invalid_request');

    const pendingId = randomToken(24);
    const gVerifier = pkce.verifier();
    const gNonce = randomToken(16);
    await redis.set(
      keys.pendingAuth(pendingId),
      JSON.stringify({
        appId: client.id,
        redirectUri: q.redirect_uri,
        codeChallenge: q.code_challenge,
        state: q.state,
        nonce: q.nonce ?? null,
        gVerifier,
        gNonce,
      }),
      'EX',
      600,
    );
    return reply.redirect(googleAuthUrl({ state: pendingId, nonce: gNonce, verifier: gVerifier, callbackUrl: callbackUrl() }));
  });

  // ---- Google callback ----
  app.get('/auth/google/callback', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const raw = q.state ? await redis.getdel(keys.pendingAuth(q.state)) : null;
    if (!raw) {
      if (req.headers.accept?.includes('text/html')) {
        return reply.redirect(`${config.consoleUrl}/?error=session_expired`);
      }
      return oauthError(reply, 400, 'invalid_request', 'unknown or expired state');
    }
    const p = JSON.parse(raw);
    const fail = (error: string) => reply.redirect(redirectWith(p.redirectUri, { error, state: p.state }));
    if (q.error || !q.code) return fail('access_denied');

    try {
      const identity = await googleExchange({ code: q.code, verifier: p.gVerifier, nonce: p.gNonce, callbackUrl: callbackUrl() });
      const { user } = await upsertFromGoogle(identity, req.ip);
      if (user.status !== 'ACTIVE') {
        await audit({ actorId: user.id, action: 'LOGIN_DENIED', appId: p.appId, ip: req.ip, metadata: { status: user.status } });
        return fail('access_denied');
      }
      const code = randomToken(32);
      await pool.query(
        `INSERT INTO auth_codes (code_hash,user_id,app_id,redirect_uri,code_challenge,nonce,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' seconds')::interval)`,
        [sha256(code), user.id, p.appId, p.redirectUri, p.codeChallenge, p.nonce, String(config.authCodeTtlSec)],
      );
      await audit({ actorId: user.id, action: 'LOGIN', appId: p.appId, ip: req.ip });
      return reply.redirect(redirectWith(p.redirectUri, { code, state: p.state }));
    } catch (e) {
      if (e instanceof DomainError) {
        await audit({ action: 'LOGIN_REJECTED', appId: p.appId, ip: req.ip, metadata: { reason: e.message } });
        return fail('access_denied');
      }
      req.log.error(e);
      return fail('server_error');
    }
  });

  // ---- /token ----
  app.post('/token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const b = (req.body ?? {}) as Record<string, string>;
    const client = await authenticateClient(req, b.client_id, b.client_secret);
    if (!client) return oauthError(reply, 401, 'invalid_client');
    const appId: string = client.app.id;

    if (b.grant_type === 'authorization_code') {
      if (!b.code || !b.code_verifier || !b.redirect_uri) return oauthError(reply, 400, 'invalid_request');
      // Atomic single-use claim.
      const row = (
        await pool.query(
          `UPDATE auth_codes SET used_at = now()
            WHERE code_hash=$1 AND used_at IS NULL AND expires_at > now() RETURNING *`,
          [sha256(b.code)],
        )
      ).rows[0];
      if (!row || row.app_id !== appId || row.redirect_uri !== b.redirect_uri) return oauthError(reply, 400, 'invalid_grant');
      if (pkce.challenge(b.code_verifier) !== row.code_challenge) return oauthError(reply, 400, 'invalid_grant', 'PKCE verification failed');

      const user = await getUser(row.user_id);
      if (!user || user.status !== 'ACTIVE') return oauthError(reply, 400, 'invalid_grant');
      await clearUserDeny(user.id);
      const [at, session, idt] = await Promise.all([
        issueAccessToken(user, appId),
        createSession({ userId: user.id, appId, userAgent: req.headers['user-agent'], ip: req.ip }),
        issueIdToken(user, appId, row.nonce),
      ]);
      if (appId === config.internalAppId) {
        reply.setCookie('acl_admin_session', at.token, {
          path: '/',
          httpOnly: true,
          secure: isProd,
          sameSite: 'lax',
          maxAge: at.expiresIn,
        });
        reply.setCookie('acl_admin_refresh', session.refresh, {
          path: '/',
          httpOnly: true,
          secure: isProd,
          sameSite: 'strict',
          maxAge: config.adminSessionTtlSec,
        });
      }
      return {
        token_type: 'Bearer',
        access_token: at.token,
        expires_in: at.expiresIn,
        refresh_token: session.refresh,
        id_token: idt,
      };
    }

    if (b.grant_type === 'refresh_token') {
      if (!b.refresh_token) return oauthError(reply, 400, 'invalid_request');
      const r = await rotateRefresh(b.refresh_token, appId);
      if (!r.ok) return oauthError(reply, 400, 'invalid_grant', r.reason);
      const user = await getUser(r.userId);
      if (!user || user.status !== 'ACTIVE') return oauthError(reply, 400, 'invalid_grant');
      await clearUserDeny(user.id);
      const at = await issueAccessToken(user, appId);
      if (appId === config.internalAppId) {
        reply.setCookie('acl_admin_session', at.token, {
          path: '/',
          httpOnly: true,
          secure: isProd,
          sameSite: 'lax',
          maxAge: at.expiresIn,
        });
        reply.setCookie('acl_admin_refresh', r.refresh, {
          path: '/',
          httpOnly: true,
          secure: isProd,
          sameSite: 'strict',
          maxAge: config.adminSessionTtlSec,
        });
      }
      return { token_type: 'Bearer', access_token: at.token, expires_in: at.expiresIn, refresh_token: r.refresh };
    }
    return oauthError(reply, 400, 'unsupported_grant_type');
  });

  // ---- /userinfo ----
  app.get('/userinfo', async (req, reply) => {
    const token = bearer(req);
    if (!token) return oauthError(reply, 401, 'invalid_token');
    try {
      const claims = await verifyJwt(token);
      if (claims.token_use === 'id') return oauthError(reply, 401, 'invalid_token', 'id_token not allowed');
      const [jtiDenied, userDenied] = await Promise.all([
        redis.exists(keys.denyJti(String(claims.jti))),
        redis.exists(keys.denyUser(String(claims.sub))),
      ]);
      if (jtiDenied || userDenied) return oauthError(reply, 401, 'invalid_token', 'revoked');
      const user = await getUser(String(claims.sub));
      if (!user || user.status !== 'ACTIVE') return oauthError(reply, 401, 'invalid_token');
      const aud = String(Array.isArray(claims.aud) ? claims.aud[0] : claims.aud);
      return buildUserInfo(user, aud);
    } catch {
      return oauthError(reply, 401, 'invalid_token');
    }
  });

  // ---- /introspect (confidential clients only) ----
  app.post('/introspect', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    const client = await authenticateClient(req, b.client_id, b.client_secret);
    if (!client || !client.authenticated) return oauthError(reply, 401, 'invalid_client');
    try {
      const claims = await verifyJwt(b.token, client.app.id); // audience-bound to the caller
      if (claims.token_use === 'id') return { active: false };
      const [jtiDenied, userDenied] = await Promise.all([
        redis.exists(keys.denyJti(String(claims.jti))),
        redis.exists(keys.denyUser(String(claims.sub))),
      ]);
      if (jtiDenied || userDenied) return { active: false };
      const user = await getUser(String(claims.sub));
      if (!user || user.status !== 'ACTIVE') return { active: false };
      if (claims.ver !== undefined && user.acl_version !== undefined && Number(claims.ver) < Number(user.acl_version)) {
        return { active: false };
      }
      return { active: true, ...claims };
    } catch {
      return { active: false };
    }
  });

  // ---- /revoke ----
  app.post('/revoke', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    const client = await authenticateClient(req, b.client_id, b.client_secret);
    if (!client) return oauthError(reply, 401, 'invalid_client');
    if (b.token) {
      await revokeRefresh(b.token);
      try {
        const c = await verifyJwt(b.token, client.app.id);
        if (c.jti && c.exp) await denyJti(String(c.jti), c.exp - Math.floor(Date.now() / 1000));
      } catch {
        /* not a JWT: refresh path handled above */
      }
    }
    return reply.code(200).send({});
  });

  // ---- /logout ----
  app.post('/logout', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    if (b.refresh_token) await revokeRefresh(b.refresh_token);
    const token = bearer(req);
    if (token) {
      try {
        const c = await verifyJwt(token);
        if (c.jti && c.exp) await denyJti(String(c.jti), c.exp - Math.floor(Date.now() / 1000));
        if (b.global === 'true' || (b as any).global === true) await revokeAllForUser(String(c.sub));
        await audit({ actorId: String(c.sub), action: 'LOGOUT', appId: String(c.aud), ip: req.ip });
      } catch {
        /* ignore */
      }
    }
    return reply.code(204).send();
  });

  // ---- Account status & ACL version freshness ----
  app.get('/acl-version/:sub', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { sub } = req.params as { sub: string };
    // Reject non-ULID subject formats to prevent email/roll_no enumeration
    if (!/^usr_[0-9A-Z]{26}$/.test(sub)) return reply.code(404).send({ error: 'not_found' });
    const u = await getUser(sub);
    if (!u) return reply.code(404).send({ error: 'not_found' });
    return { sub, status: u.status, active: u.status === 'ACTIVE', ver: u.acl_version ?? 1 };
  });
}
