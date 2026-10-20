import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server.js';
import { pool } from '../src/db/pool.js';
import { redis } from '../src/redis.js';
import { createAclClient, AclError } from '../sdk/index.js';
import { login } from './helpers.js';

let app: FastifyInstance;
let jwks: any;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  jwks = (await app.inject({ url: '/.well-known/jwks.json' })).json();
});
afterAll(async () => {
  await app.close();
  await pool.end();
  redis.disconnect();
});

describe('sdk', () => {
  it('verifies tokens locally, enforces audience, permission and scope', async () => {
    const r = await login(app, { email: 'sdk.user@nsut.ac.in', appId: 'CRAS' });
    if (r.stage !== 'done') throw new Error('x');
    const cras = createAclClient({ issuer: 'http://localhost:4000', appId: 'CRAS', jwks });
    const other = createAclClient({ issuer: 'http://localhost:4000', appId: 'OTHER', jwks });

    const claims = await cras.verify(r.tokens.access_token);
    expect(cras.hasPermission(claims, 'cras.calendar')).toBe(true);
    expect(cras.hasPermission(claims, 'cras.bookings')).toBe(false);
    expect(cras.inScope(claims, { branch: 'CSAI' })).toBe(true); // no scope => unrestricted
    await expect(other.verify(r.tokens.access_token)).rejects.toBeInstanceOf(AclError);
    await expect(cras.verify(r.tokens.access_token + 'x')).rejects.toBeInstanceOf(AclError);

    // express-style middleware
    const req: any = { headers: { authorization: `Bearer ${r.tokens.access_token}` } };
    let nextCalled = false;
    await cras.authenticate()(req, {}, () => (nextCalled = true));
    expect(nextCalled).toBe(true);

    const sent: any = {};
    const res: any = { status: (c: number) => ({ json: (b: unknown) => Object.assign(sent, { c, b }) }), json: () => {} };
    await cras.requirePermission('cras.bookings')(req, res, () => {});
    expect(sent.c).toBe(403);
  });

  it('freshness check rejects stale tokens', async () => {
    const r = await login(app, { email: 'sdk.stale@nsut.ac.in', appId: 'CRAS' });
    if (r.stage !== 'done') throw new Error('x');
    const id = (await pool.query(`SELECT id FROM users WHERE email='sdk.stale@nsut.ac.in'`)).rows[0].id;
    // serve /acl-version through the in-process app
    const fetchImpl = (async (url: URL) => {
      const res = await app.inject({ url: url.pathname });
      return { ok: res.statusCode === 200, json: async () => res.json() };
    }) as any;
    const client = createAclClient({ issuer: 'http://localhost:4000', appId: 'CRAS', jwks, checkVersion: true, fetchImpl });
    await expect(client.verify(r.tokens.access_token)).resolves.toBeTruthy();
    await pool.query(`UPDATE users SET status = 'SUSPENDED' WHERE id=$1`, [id]);
    await expect(client.verify(r.tokens.access_token)).rejects.toThrow();
  });
});
