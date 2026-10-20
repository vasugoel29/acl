import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';

export const pkcePair = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};

export function googleCallbackFromRedirect(authorizeLocation: string, email: string, name?: string) {
  const gUrl = new URL(authorizeLocation);
  const gState = gUrl.searchParams.get('state')!;
  const gNonce = gUrl.searchParams.get('nonce')!;
  const cleanEmail = email.trim().toLowerCase();
  const claims = {
    sub: `google-${cleanEmail}`,
    email: cleanEmail,
    email_verified: true,
    hd: cleanEmail.split('@')[1],
    name: name ? name.trim() : cleanEmail.split('@')[0],
    nonce: gNonce,
  };
  const code = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `/auth/google/callback?${new URLSearchParams({ code, state: gState })}`;
}

/** Drive the whole authorization-code flow against the in-process app. */
export async function login(app: FastifyInstance, opts: { email: string; appId: string; redirectUri?: string; name?: string }) {
  const redirectUri = opts.redirectUri ?? redirectFor(opts.appId);
  const { verifier, challenge } = pkcePair();
  const state = crypto.randomBytes(8).toString('hex');

  const a = await app.inject({
    method: 'GET',
    url: '/authorize?' + new URLSearchParams({ response_type: 'code', client_id: opts.appId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state }),
  });
  if (a.statusCode !== 302) return { stage: 'authorize' as const, res: a };
  const cbUrl = googleCallbackFromRedirect(a.headers.location as string, opts.email, opts.name);
  const cb = await app.inject({ method: 'GET', url: cbUrl });
  const final = new URL(cb.headers.location as string);
  const code = final.searchParams.get('code');
  if (!code) return { stage: 'callback' as const, res: cb, error: final.searchParams.get('error'), state: final.searchParams.get('state'), sentState: state };

  const tok = await exchange(app, { appId: opts.appId, code, verifier, redirectUri });
  return { stage: 'done' as const, code, verifier, redirectUri, tokens: tok.json(), tokenRes: tok, state: final.searchParams.get('state'), sentState: state };
}

export const redirectFor = (appId: string) =>
  ({
    ACL: 'http://localhost:5173/callback',
    app_01JACL00000000000000000000: 'http://localhost:5173/callback',
    CRAS: 'http://localhost:3001/callback',
    app_01JCRAS0000000000000000000: 'http://localhost:3001/callback',
    HAJIRI: 'http://localhost:3002/callback',
    app_01JHAJIRI00000000000000000: 'http://localhost:3002/callback',
    EVENTS: 'http://localhost:3003/callback',
  } as Record<string, string>)[appId];

export const exchange = (app: FastifyInstance, o: { appId: string; code: string; verifier: string; redirectUri: string }) =>
  app.inject({
    method: 'POST',
    url: '/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ grant_type: 'authorization_code', client_id: o.appId, code: o.code, code_verifier: o.verifier, redirect_uri: o.redirectUri }).toString(),
  });

export const refresh = (app: FastifyInstance, appId: string, refresh_token: string) =>
  app.inject({
    method: 'POST',
    url: '/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ grant_type: 'refresh_token', client_id: appId, refresh_token }).toString(),
  });

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });
