/**
 * Upstream Google OIDC + server-side domain enforcement (spec §2.2).
 * The `hd` request parameter is a UX hint only; verifyGoogleClaims is the real gate.
 */
import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from '../config.js';

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

export class DomainError extends Error {}

export function isDomainAllowed(email: string): boolean {
  const clean = email.trim().toLowerCase();
  const parts = clean.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const domain = parts[1];
  return config.allowedDomains.includes(domain);
}

export function verifyGoogleClaims(c: Record<string, unknown>): GoogleIdentity {
  const email = String(c.email ?? '').trim().toLowerCase();
  if (c.email_verified !== true) throw new DomainError('email not verified');
  if (!c.hd) throw new DomainError('missing hd');
  const hd = typeof c.hd === 'string' ? c.hd.trim().toLowerCase() : undefined;
  if (!isDomainAllowed(email)) throw new DomainError('email domain not allowed');
  if (!hd || !config.allowedDomains.includes(hd)) {
    throw new DomainError('hosted domain mismatch');
  }
  if (!c.sub) throw new DomainError('missing sub');
  return { sub: String(c.sub), email, name: String(c.name ?? email.split('@')[0]), picture: c.picture as string | undefined };
}

export const pkce = {
  verifier: () => crypto.randomBytes(32).toString('base64url'),
  challenge: (v: string) => crypto.createHash('sha256').update(v).digest('base64url'),
};

const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export function googleAuthUrl(p: { state: string; nonce: string; verifier: string; callbackUrl: string }) {
  return (
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: config.google.clientId ?? '',
      redirect_uri: p.callbackUrl,
      response_type: 'code',
      scope: 'openid email profile',
      state: p.state,
      nonce: p.nonce,
      hd: config.allowedDomain, // hint only
      code_challenge: pkce.challenge(p.verifier),
      code_challenge_method: 'S256',
    })
  );
}

export async function googleExchange(p: { code: string; verifier: string; nonce: string; callbackUrl: string }): Promise<GoogleIdentity> {
  if (config.nodeEnv === 'test' && !config.google.clientId) {
    const claims = JSON.parse(Buffer.from(p.code, 'base64url').toString());
    if (claims.nonce !== p.nonce) throw new DomainError('nonce mismatch');
    return verifyGoogleClaims(claims);
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: p.code,
      client_id: config.google.clientId!,
      client_secret: config.google.clientSecret!,
      redirect_uri: p.callbackUrl,
      grant_type: 'authorization_code',
      code_verifier: p.verifier,
    }),
  });
  if (!res.ok) throw new DomainError('google token exchange failed');
  const { id_token } = (await res.json()) as { id_token: string };
  const { payload } = await jwtVerify(id_token, googleJwks, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: config.google.clientId!,
  });
  if (payload.nonce !== p.nonce) throw new DomainError('nonce mismatch');
  return verifyGoogleClaims(payload as Record<string, unknown>);
}
