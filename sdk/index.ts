/**
 * NSUT Identity & ACL — client SDK for campus apps (spec §2.6 / §2.8).
 *
 *   const acl = createAclClient({ issuer: 'https://id.nsut.example', appId: 'CRAS' });
 *   app.use(acl.authenticate());                       // verifies JWT locally via JWKS
 *   app.post('/book', acl.requirePermission('rooms:book'), (req, res) => {
 *     if (!acl.inScope(req.auth, { branch: 'CSAI', section: 1 })) return res.status(403).end();
 *   });
 *
 * Works with Express-style `(req, res, next)` and Fastify-style `(req, reply)` hooks.
 */
import { createRemoteJWKSet, createLocalJWKSet, jwtVerify, type JWTPayload, type JSONWebKeySet } from 'jose';

export type ScopeValue = string | number | Array<string | number>;

export interface AclClaims extends JWTPayload {
  email: string;
  type: 'STUDENT' | 'FACULTY' | 'STAFF' | 'ADMIN';
  role: string | null;
  roles: string[];
  permissions: string[];
  scope: Record<string, ScopeValue>;
  ver: number;
}

export interface AclClientOptions {
  issuer: string;
  /** Your app key; tokens whose `aud` differs are rejected (audience-bound tokens). */
  appId: string;
  /** Override JWKS (tests / pinned keys). Defaults to `${issuer}/.well-known/jwks.json`, cached with `kid` rotation. */
  jwks?: JSONWebKeySet;
  /** Optional freshness check (spec §2.9 option 2): reject tokens older than the user's published ACL version. */
  checkVersion?: boolean;
  fetchImpl?: typeof fetch;
}

export class AclError extends Error {
  constructor(public status: 401 | 403, message: string) {
    super(message);
  }
}

const arr = (v: ScopeValue) => (Array.isArray(v) ? v : [v]);

export function createAclClient(opts: AclClientOptions) {
  const base = opts.issuer.endsWith('/') ? opts.issuer : `${opts.issuer}/`;
  const keyset = opts.jwks
    ? createLocalJWKSet(opts.jwks)
    : createRemoteJWKSet(new URL('.well-known/jwks.json', base), { cooldownDuration: 30_000 });
  const doFetch = opts.fetchImpl ?? fetch;

  async function verify(token: string): Promise<AclClaims> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keyset, { issuer: opts.issuer, audience: opts.appId, algorithms: ['ES256'] }));
    } catch (e: any) {
      throw new AclError(401, `invalid token: ${e.code ?? e.message}`);
    }
    if (payload.token_use === 'id') {
      throw new AclError(401, 'invalid token: id_token cannot be used as access_token');
    }
    if (opts.checkVersion) {
      try {
        const r = await doFetch(new URL(`acl-version/${encodeURIComponent(String(payload.sub))}`, base), {
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) {
          throw new AclError(401, `version check failed with status ${r.status}`);
        }
        const body = (await r.json()) as any;
        if (body.active === false || body.status === 'SUSPENDED') throw new AclError(401, 'stale token: account inactive');
        const tokenVer = Number(payload.ver);
        if (!Number.isFinite(tokenVer)) {
          throw new AclError(401, 'stale token: invalid token version');
        }
        if (body.ver && Number(body.ver) > tokenVer) throw new AclError(401, 'stale token: refresh required');
      } catch (e: any) {
        if (e instanceof AclError) throw e;
        throw new AclError(401, `version check failed: ${e.message}`);
      }
    }
    return payload as AclClaims;
  }

  const hasPermission = (auth: Pick<AclClaims, 'permissions'> | undefined, permission: string) => !!auth?.permissions?.includes(permission);

  /**
   * Checks the resource against the token's summarised scope. A token scope is the per-key union over all
   * of the user's scoped roles, so for multi-role users with differing scopes use the server-side
   * `/v1/authorize/check` for an exact per-permission answer.
   */
  function inScope(auth: Pick<AclClaims, 'scope'> | undefined, resource: Record<string, string | number>): boolean {
    if (!auth) return false;
    for (const [k, allowed] of Object.entries(auth.scope ?? {})) {
      if (!Object.prototype.hasOwnProperty.call(resource, k) || !arr(allowed).map(String).includes(String(resource[k]))) return false;
    }
    return true;
  }

  const bearer = (h?: string) => (h?.startsWith('Bearer ') ? h.slice(7) : null);

  /** Express: authenticate()(req,res,next). Fastify: use as preHandler (req, reply). */
  function authenticate() {
    return async (req: any, res: any, next?: (err?: unknown) => void) => {
      try {
        const token = bearer(req.headers?.authorization);
        if (!token) throw new AclError(401, 'missing bearer token');
        req.auth = await verify(token);
        next?.();
      } catch (e) {
        return fail(res, next, e);
      }
    };
  }

  function requirePermission(...permissions: string[]) {
    return async (req: any, res: any, next?: (err?: unknown) => void) => {
      if (!req.auth) return fail(res, next, new AclError(401, 'unauthenticated'));
      const missing = permissions.filter((p) => !hasPermission(req.auth, p));
      if (missing.length) return fail(res, next, new AclError(403, `missing permission: ${missing.join(', ')}`));
      next?.();
    };
  }

  function fail(res: any, next: ((err?: unknown) => void) | undefined, e: unknown) {
    const err = e instanceof AclError ? e : new AclError(401, 'unauthorized');
    if (res?.status && res?.json) return res.status(err.status).json({ error: err.message }); // express
    if (res?.code && res?.send) return res.code(err.status).send({ error: err.message }); // fastify
    return next?.(err);
  }

  return { verify, hasPermission, inScope, authenticate, requirePermission };
}
