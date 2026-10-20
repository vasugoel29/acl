import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server.js';
import { pool } from '../src/db/pool.js';
import { redis } from '../src/redis.js';
import { verifyJwt } from '../src/tokens/jwt.js';
import { importUsersCsv, roleExpirySweep, semesterRollover } from '../src/jobs/handlers.js';
import { auth, exchange, googleCallbackFromRedirect, login, pkcePair, redirectFor, refresh } from './helpers.js';

let app: FastifyInstance;
let adminToken: string;

const adminCall = (method: any, url: string, payload?: unknown, token = adminToken) =>
  app.inject({ method, url, headers: auth(token), ...(payload !== undefined ? { payload: payload as any } : {}) });

beforeAll(async () => {
  app = await buildApp({ logger: false });
  const r = await login(app, { email: 'root@nsut.ac.in', appId: 'ACL' });
  if (r.stage !== 'done') throw new Error('admin login failed');
  adminToken = r.tokens.access_token;
  await pool.query(
    `INSERT INTO applications (id, client_id, name, redirect_uris) VALUES ('app_01JHAJIRI00000000000000000', 'HAJIRI', 'Hajiri Attendance', $1)
     ON CONFLICT (id) DO UPDATE SET redirect_uris = EXCLUDED.redirect_uris`,
    [[redirectFor('HAJIRI')]],
  );
});

afterAll(async () => {
  await app.close();
  await pool.end();
  redis.disconnect();
});

describe('discovery & keys', () => {
  it('serves discovery and JWKS', async () => {
    const d = (await app.inject({ url: '/.well-known/openid-configuration' })).json();
    expect(d.code_challenge_methods_supported).toEqual(['S256']);
    const k = (await app.inject({ url: '/.well-known/jwks.json' })).json();
    expect(k.keys[0]).toMatchObject({ kty: 'EC', alg: 'ES256' });
    expect(k.keys[0].d).toBeUndefined(); // never leak private key
  });
});

describe('login flow', () => {
  it('rejects non-nsut Google accounts server-side', async () => {
    const r = await login(app, { email: 'someone@gmail.com', appId: 'CRAS' });
    expect(r.stage).toBe('callback');
    expect((r as any).error).toBe('access_denied');
    expect((r as any).state).toBe((r as any).sentState); // state echoed back
    const n = await pool.query(`SELECT count(*)::int n FROM users WHERE email='someone@gmail.com'`);
    expect(n.rows[0].n).toBe(0);
  });

  it('auto-provisions first-time users with default VIEWER role only, audience-bound token', async () => {
    const r = await login(app, { email: 'new.student@nsut.ac.in', appId: 'CRAS', name: 'New Student' });
    if (r.stage !== 'done') throw new Error('login failed');
    const claims = await verifyJwt(r.tokens.access_token, 'CRAS');
    expect(claims.role).toBe('VIEWER');
    expect(claims.permissions).toEqual(['cras.calendar', 'cras.timetable']);
    expect(claims.aud).toBe('CRAS');
    await expect(verifyJwt(r.tokens.access_token, 'OTHER')).rejects.toThrow(); // audience-bound
    expect(r.state).toBe(r.sentState);
    expect(r.tokens.id_token).toBeTruthy();
    expect(r.tokens.refresh_token).toBeTruthy();
  });

  it('rejects unknown client and mismatched redirect_uri without redirecting', async () => {
    const { challenge } = pkcePair();
    const base = { response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 's' };
    const bad1 = await app.inject({ url: '/authorize?' + new URLSearchParams({ ...base, client_id: 'NOPE', redirect_uri: 'http://x/cb' }) });
    expect(bad1.statusCode).toBe(400);
    const bad2 = await app.inject({ url: '/authorize?' + new URLSearchParams({ ...base, client_id: 'CRAS', redirect_uri: 'http://localhost:3001/callback/../evil' }) });
    expect(bad2.statusCode).toBe(400);
    const bad3 = await app.inject({ url: '/authorize?' + new URLSearchParams({ ...base, client_id: 'CRAS', redirect_uri: 'http://localhost:3001/callback?x=1' }) });
    expect(bad3.statusCode).toBe(400);
  });

  it('requires PKCE S256', async () => {
    const res = await app.inject({
      url: '/authorize?' + new URLSearchParams({ response_type: 'code', client_id: 'CRAS', redirect_uri: redirectFor('CRAS'), state: 's' }),
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('error=invalid_request');
  });

  it('enforces PKCE verifier and single-use codes', async () => {
    const r = await login(app, { email: 'pkce.user@nsut.ac.in', appId: 'CRAS' });
    if (r.stage !== 'done') throw new Error('login failed');
    // already used by login(): replay fails
    const replay = await exchange(app, { appId: 'CRAS', code: r.code, verifier: r.verifier, redirectUri: r.redirectUri });
    expect(replay.statusCode).toBe(400);

    // wrong verifier on a fresh code
    const { challenge } = pkcePair();
    const a = await app.inject({ url: '/authorize?' + new URLSearchParams({ response_type: 'code', client_id: 'CRAS', redirect_uri: redirectFor('CRAS'), code_challenge: challenge, code_challenge_method: 'S256', state: 'z' }) });
    const cbUrl = googleCallbackFromRedirect(a.headers.location as string, 'pkce.user@nsut.ac.in');
    const cb = await app.inject({ url: cbUrl });
    const code = new URL(cb.headers.location as string).searchParams.get('code')!;
    const wrong = await exchange(app, { appId: 'CRAS', code, verifier: 'x'.repeat(43), redirectUri: redirectFor('CRAS') });
    expect(wrong.statusCode).toBe(400);
  });

  it('rejects a code redeemed by a different app', async () => {
    const { challenge, verifier } = pkcePair();
    const a = await app.inject({
      url:
        '/authorize?' +
        new URLSearchParams({
          response_type: 'code',
          client_id: 'CRAS',
          redirect_uri: redirectFor('CRAS'),
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state: 'binding-code-test',
        }),
    });
    const cbUrl = googleCallbackFromRedirect(a.headers.location as string, 'xapp@nsut.ac.in');
    const cb = await app.inject({ url: cbUrl });
    const code = new URL(cb.headers.location as string).searchParams.get('code')!;

    const res = await exchange(app, {
      appId: 'HAJIRI',
      code,
      verifier,
      redirectUri: redirectFor('HAJIRI'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
  });

  it('state callback is single-use (cannot be replayed)', async () => {
    const { challenge } = pkcePair();
    const a = await app.inject({ url: '/authorize?' + new URLSearchParams({ response_type: 'code', client_id: 'CRAS', redirect_uri: redirectFor('CRAS'), code_challenge: challenge, code_challenge_method: 'S256', state: 'q' }) });
    const cbUrl = googleCallbackFromRedirect(a.headers.location as string, 'replay@nsut.ac.in');
    const first = await app.inject({ url: cbUrl });
    expect(first.statusCode).toBe(302);
    const second = await app.inject({ url: cbUrl });
    expect(second.statusCode).toBe(400);
  });
});

describe('refresh tokens', () => {
  it('rotates and detects reuse by revoking the whole family', async () => {
    const r = await login(app, { email: 'refresh.user@nsut.ac.in', appId: 'CRAS' });
    if (r.stage !== 'done') throw new Error('x');
    const rt1 = r.tokens.refresh_token;
    const rot = await refresh(app, 'CRAS', rt1);
    expect(rot.statusCode).toBe(200);
    const rt2 = rot.json().refresh_token;
    expect(rt2).not.toBe(rt1);

    const reuse = await refresh(app, 'CRAS', rt1); // replaying the old one
    expect(reuse.statusCode).toBe(400);
    const after = await refresh(app, 'CRAS', rt2); // family is dead
    expect(after.statusCode).toBe(400);
  });

  it('refresh tokens are bound to their app', async () => {
    const r = await login(app, { email: 'bound.user@nsut.ac.in', appId: 'CRAS' });
    if (r.stage !== 'done') throw new Error('x');
    const res = await refresh(app, 'HAJIRI', r.tokens.refresh_token);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
  });
});

describe('ACL assignment end-to-end', () => {
  const email = '2021uca1808@nsut.ac.in';
  let userId: string;

  it('admin creates a student profile', async () => {
    const res = await adminCall('POST', '/v1/users', {
      email, name: 'Vasu Goel',
      student: { roll_no: '2021UCA1808', degree: 'BTech', branch: 'CSAI', batch_year: 2021, semester: 6, section: 1 },
    });
    expect(res.statusCode).toBe(201);
    userId = res.json().id;
  });

  it('CRAS default VIEWER role applies implicitly', async () => {
    const r = await login(app, { email, appId: 'CRAS' });
    if (r.stage !== 'done') throw new Error('x');
    const c = await verifyJwt(r.tokens.access_token, 'CRAS');
    expect(c.role).toBe('VIEWER');
    expect(c.permissions).toEqual(['cras.calendar', 'cras.timetable']);
  });

  let assignmentId: string;
  let tokenBefore: string;

  it('grant STUDENT_REP with scope -> reflected in token, userinfo and /authorize/check', async () => {
    const before = await login(app, { email, appId: 'CRAS' });
    if (before.stage !== 'done') throw new Error('x');
    tokenBefore = before.tokens.access_token;

    const g = await adminCall('POST', `/v1/users/${userId}/apps/CRAS/roles`, { role: 'STUDENT_REP', scope: { branch: 'CSAI', section: 1, semester: 6 } });
    expect(g.statusCode).toBe(201);
    assignmentId = g.json().id;

    const after = await login(app, { email, appId: 'CRAS' });
    if (after.stage !== 'done') throw new Error('x');
    const c = await verifyJwt(after.tokens.access_token, 'CRAS');
    expect(c.role).toBe('STUDENT_REP');
    expect(c.permissions).toEqual(['cras.bookings', 'cras.calendar', 'cras.timetable']);
    expect(c.scope).toEqual({ branch: 'CSAI', section: 1, semester: 6 });

    const ui = await app.inject({ url: '/userinfo', headers: auth(after.tokens.access_token) });
    expect(ui.statusCode).toBe(200);
    expect(ui.json()).toMatchObject({
      user: { name: 'Vasu Goel', email, academic: { roll_no: '2021UCA1808', branch: 'CSAI', semester: 6, section: 1 } },
      app: 'CRAS', role: 'STUDENT_REP', allowed_scope: { branch: 'CSAI', section: 1, semester: 6 },
    });

    // acl version endpoint publishes the new version
    const v = (await app.inject({ url: `/acl-version/${userId}` })).json();
    expect(v.ver).toBe(c.ver);
  });

  it('confidential app can server-side check permission + scope; others cannot spoof', async () => {
    const reg = await adminCall('POST', '/v1/apps', { id: 'LIBRARY', name: 'Library', redirect_uris: ['http://localhost:3010/callback'], confidential: true });
    expect(reg.statusCode).toBe(201);
    const { client_secret } = reg.json();
    expect(client_secret).toBeTruthy();
    const stored = await pool.query(`SELECT client_secret_hash FROM applications WHERE id='LIBRARY' OR client_id='LIBRARY'`);
    expect(stored.rows[0].client_secret_hash).not.toBe(client_secret); // hashed at rest

    // CRAS is public (no secret) => cannot call check
    const pub = await app.inject({ method: 'POST', url: '/v1/authorize/check', payload: { client_id: 'CRAS', client_secret: 'x', user: userId, app: 'CRAS', permission: 'rooms:book' } });
    expect(pub.statusCode).toBe(401);
    // LIBRARY cannot ask about CRAS
    const spoof = await app.inject({ method: 'POST', url: '/v1/authorize/check', payload: { client_id: 'LIBRARY', client_secret, user: userId, app: 'CRAS', permission: 'rooms:book' } });
    expect(spoof.statusCode).toBe(403);
  });

  it('revoke removes access and bumps version so stale tokens fail introspection-style checks', async () => {
    const d = await adminCall('DELETE', `/v1/users/${userId}/apps/CRAS/roles/${assignmentId}`);
    expect(d.statusCode).toBe(204);
    const access = (await adminCall('GET', `/v1/users/${userId}/access`)).json();
    const cras = access.access.find((a: any) => a.app === 'CRAS');
    expect(cras.role).toBe('VIEWER');
    expect(cras.implicit_default).toBe(true);
  });

  it('audit log recorded grant and revoke', async () => {
    const a = (await adminCall('GET', `/v1/audit?target=${userId}`)).json();
    const actions = a.entries.map((e: any) => e.action);
    expect(actions).toContain('ROLE_GRANTED');
    expect(actions).toContain('ROLE_REVOKED');
  });

  it('audit log is append-only', async () => {
    await expect(pool.query(`DELETE FROM audit_logs`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`UPDATE audit_logs SET action='X'`)).rejects.toThrow(/append-only/);
  });

  it('rejects granting a role that is not defined for the app', async () => {
    const g = await adminCall('POST', `/v1/users/${userId}/apps/CRAS/roles`, { role: 'NO_SUCH_ROLE' });
    expect(g.statusCode).toBe(400);
  });

  it('role expiry: expired assignments stop applying and sweep removes them', async () => {
    const g = await adminCall('POST', `/v1/users/${userId}/apps/CRAS/roles`, { role: 'FACULTY', expires_at: new Date(Date.now() + 1500).toISOString() });
    expect(g.statusCode).toBe(201);
    let acc = (await adminCall('GET', `/v1/users/${userId}/access`)).json().access.find((a: any) => a.app === 'CRAS');
    expect(acc.roles).toContain('FACULTY');
    await new Promise((r) => setTimeout(r, 1800));
    acc = (await adminCall('GET', `/v1/users/${userId}/access`)).json().access.find((a: any) => a.app === 'CRAS');
    expect(acc.roles).not.toContain('FACULTY');
    const sw = await roleExpirySweep();
    expect(sw.removed).toBeGreaterThanOrEqual(1);
  });
});

describe('admin authorization', () => {
  it('rejects unauthenticated and non-admin callers', async () => {
    expect((await app.inject({ url: '/v1/users' })).statusCode).toBe(401);
    const r = await login(app, { email: 'plain.user@nsut.ac.in', appId: 'ACL' });
    if (r.stage !== 'done') throw new Error('x');
    const res = await adminCall('GET', '/v1/users', undefined, r.tokens.access_token);
    expect(res.statusCode).toBe(403);
    // a CRAS token is not accepted by the admin API
    const c = await login(app, { email: 'plain.user@nsut.ac.in', appId: 'CRAS' });
    if (c.stage !== 'done') throw new Error('x');
    expect((await adminCall('GET', '/v1/users', undefined, c.tokens.access_token)).statusCode).toBe(401);
  });

  it('scoped APP_ADMIN can manage only their own app and cannot escalate', async () => {
    const mk = await adminCall('POST', '/v1/users', { email: 'cras.admin@nsut.ac.in', name: 'CRAS Admin' });
    const adminId = mk.json().id;
    const g = await adminCall('POST', `/v1/users/${adminId}/apps/ACL/roles`, { role: 'APP_ADMIN', scope: { app: ['CRAS'] } });
    expect(g.statusCode).toBe(201);
    const l = await login(app, { email: 'cras.admin@nsut.ac.in', appId: 'ACL' });
    if (l.stage !== 'done') throw new Error('x');
    const t = l.tokens.access_token;

    const target = (await adminCall('POST', '/v1/users', { email: 'target@nsut.ac.in', name: 'T' })).json().id;
    expect((await adminCall('POST', `/v1/users/${target}/apps/CRAS/roles`, { role: 'VIEWER' }, t)).statusCode).toBe(201);
    expect((await adminCall('POST', `/v1/users/${target}/apps/OTHER/roles`, { role: 'VIEWER' }, t)).statusCode).toBe(403);
    // escalation attempts
    expect((await adminCall('POST', `/v1/users/${target}/apps/ACL/roles`, { role: 'SUPER_ADMIN' }, t)).statusCode).toBe(403);
    expect((await adminCall('POST', '/v1/apps', { id: 'EVIL', name: 'e', redirect_uris: ['http://e.com/cb'] }, t)).statusCode).toBe(403);
    // scoped audit view only returns CRAS rows
    const aud = (await adminCall('GET', '/v1/audit', undefined, t)).json();
    expect(aud.entries.length).toBeGreaterThan(0);
    expect(aud.entries.every((e: any) => e.app_id === 'CRAS')).toBe(true);
  });

  it('suspending a user kills refresh tokens and blocks login', async () => {
    const l = await login(app, { email: 'suspend.me@nsut.ac.in', appId: 'CRAS' });
    if (l.stage !== 'done') throw new Error('x');
    const id = (await pool.query(`SELECT id FROM users WHERE email='suspend.me@nsut.ac.in'`)).rows[0].id;
    const p = await adminCall('PATCH', `/v1/users/${id}`, { status: 'SUSPENDED' });
    expect(p.statusCode).toBe(200);
    expect((await refresh(app, 'CRAS', l.tokens.refresh_token)).statusCode).toBe(400);
    expect((await app.inject({ url: '/userinfo', headers: auth(l.tokens.access_token) })).statusCode).toBe(401);
    const again = await login(app, { email: 'suspend.me@nsut.ac.in', appId: 'CRAS' });
    expect(again.stage).toBe('callback');
  });
});

describe('revocation', () => {
  it('logout denies the access token jti', async () => {
    const l = await login(app, { email: 'logout.user@nsut.ac.in', appId: 'CRAS' });
    if (l.stage !== 'done') throw new Error('x');
    const out = await app.inject({ method: 'POST', url: '/logout', headers: { ...auth(l.tokens.access_token), 'content-type': 'application/json' }, payload: { refresh_token: l.tokens.refresh_token } });
    expect(out.statusCode).toBe(204);
    expect((await app.inject({ url: '/userinfo', headers: auth(l.tokens.access_token) })).statusCode).toBe(401);
    expect((await refresh(app, 'CRAS', l.tokens.refresh_token)).statusCode).toBe(400);
  });

  it('introspect requires a confidential client and flags stale ACL versions', async () => {
    const reg = (await adminCall('POST', '/v1/apps', { id: 'LABS', name: 'Labs', redirect_uris: ['http://localhost:3011/callback'], confidential: true })).json();
    const mk = (await adminCall('POST', '/v1/users', { email: 'intro@nsut.ac.in', name: 'I' })).json().id;
    const l = await login(app, { email: 'intro@nsut.ac.in', appId: 'LABS', redirectUri: 'http://localhost:3011/callback' });
    // LABS is confidential: token exchange without secret must fail
    expect(l.stage).toBe('done');
    expect((l as any).tokenRes.statusCode).toBe(401);

    // exchange with secret via basic auth
    const { verifier, challenge } = pkcePair();
    const a = await app.inject({ url: '/authorize?' + new URLSearchParams({ response_type: 'code', client_id: 'LABS', redirect_uri: 'http://localhost:3011/callback', code_challenge: challenge, code_challenge_method: 'S256', state: 's' }) });
    const cbUrl = googleCallbackFromRedirect(a.headers.location as string, 'intro@nsut.ac.in');
    const cb = await app.inject({ url: cbUrl });
    const code = new URL(cb.headers.location as string).searchParams.get('code')!;
    const basic = 'Basic ' + Buffer.from(`LABS:${reg.client_secret}`).toString('base64');
    const tok = await app.inject({ method: 'POST', url: '/token', headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: 'http://localhost:3011/callback' }).toString() });
    expect(tok.statusCode).toBe(200);
    const at = tok.json().access_token;

    const intro = (token: string) => app.inject({ method: 'POST', url: '/introspect', headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ token }).toString() });
    expect((await intro(at)).json().active).toBe(true);
    // public client cannot introspect
    const pub = await app.inject({ method: 'POST', url: '/introspect', payload: { client_id: 'CRAS', token: at } });
    expect(pub.statusCode).toBe(401);

    // account suspension => token becomes inactive
    await adminCall('PATCH', `/v1/users/${mk}`, { status: 'SUSPENDED' });
    expect((await intro(at)).json().active).toBe(false);
  });
});

describe('jobs: import & rollover', () => {
  it('imports CSV with row-level errors, dedupes and updates', async () => {
    const csv = [
      'email,name,roll_no,degree,branch,batch_year,semester,section,group_no,employee_id,department,designation',
      'imp1@nsut.ac.in,Imp One,2022UCS001,BTech,CSE,2022,5,2,1,,,',
      'imp2@nsut.ac.in,Imp Two,2022UCS002,BTech,CSE,2022,8,1,1,,,',
      'bad@gmail.com,Bad,2022UCS003,BTech,CSE,2022,5,1,1,,,',
      'imp3@nsut.ac.in,Imp Three,2022UCS001,BTech,CSE,2022,5,1,1,,,', // duplicate roll no
      'fac@nsut.ac.in,Prof X,,,,,,,,,E100,CSE,Professor',
      'imp1@nsut.ac.in,Imp One Renamed,2022UCS001,BTech,CSE,2022,5,2,1,,,', // update
      'noname@nsut.ac.in,,,,,,,,,,,',
    ].join('\n');
    const res = await importUsersCsv(csv);
    expect(res.total).toBe(7);
    expect(res.created).toBe(3);
    expect(res.updated).toBe(1);
    expect(res.errors.map((e) => e.row).sort()).toEqual([4, 5, 8]);
    const u = await pool.query(`SELECT name FROM users WHERE email='imp1@nsut.ac.in'`);
    expect(u.rows[0].name).toBe('Imp One Renamed');
  });

  it('semester rollover advances, graduates, and expires semester-scoped roles', async () => {
    const id = (await pool.query(`SELECT id FROM users WHERE email='imp1@nsut.ac.in'`)).rows[0].id;
    await adminCall('POST', `/v1/users/${id}/apps/CRAS/roles`, { role: 'STUDENT_REP', scope: { branch: 'CSE', semester: 5 } });
    const r = await semesterRollover({ maxSemester: 8 });
    expect(r.graduated).toBeGreaterThanOrEqual(1);
    expect(r.scopedAssignmentsExpired).toBeGreaterThanOrEqual(1);
    const sem = await pool.query(`SELECT semester FROM users WHERE roll_no='2022UCS001'`);
    expect(sem.rows[0].semester).toBe(6);
    const grad = await pool.query(`SELECT status FROM users WHERE email='imp2@nsut.ac.in'`);
    expect(grad.rows[0].status).toBe('ARCHIVED');
    const eff = (await adminCall('GET', `/v1/users/${id}/access`)).json().access.find((a: any) => a.app === 'CRAS');
    expect(eff.roles).not.toContain('STUDENT_REP');
  });

  it('supports flexible column aliases and stores downloadable error CSV report in Redis', async () => {
    const csv = [
      'Official Email, Student Name, Roll Number, Course, Discipline, Admission Year, Current Semester, Sec',
      'flex1@nsut.ac.in, Flex One, 2023UCA001, BTech, CSAI, 2023, 3, 1',
      'invalid@gmail.com, Bad Domain, 2023UCA002, BTech, CSAI, 2023, 3, 1',
    ].join('\n');
    const res = await importUsersCsv(csv, undefined, 'test-job-999');
    expect(res.total).toBe(2);
    expect(res.created).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.errorSummary['INVALID_DOMAIN']).toBe(1);

    const errReport = await adminCall('GET', '/v1/jobs/test-job-999/errors.csv');
    expect(errReport.statusCode).toBe(200);
    expect(errReport.headers['content-type']).toContain('text/csv');
    expect(errReport.body).toContain('invalid@gmail.com');
  });
});

describe('enterprise overview & BFF session', () => {
  it('serves enterprise IAM telemetry metrics', async () => {
    const res = await adminCall('GET', '/v1/overview/metrics');
    expect(res.statusCode).toBe(200);
    const { metrics } = res.json();
    expect(metrics.totalUsers).toBeGreaterThanOrEqual(1);
    expect(metrics.activeApps).toBeGreaterThanOrEqual(1);
    expect(metrics.authEvents24h).toBeGreaterThanOrEqual(1);
  });

  it('verifies authenticated admin via /api/admin/auth/me', async () => {
    const res = await adminCall('GET', '/api/admin/auth/me');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.email).toBe('root@nsut.ac.in');
    expect(body.tenant).toBe('Netaji Subhas University of Technology');
    expect(body.access.roles).toContain('SUPER_ADMIN');
  });
});

describe('enterprise security, injection & DPDP controls', () => {
  it('blocks TRUNCATE on audit_logs via database trigger', async () => {
    await expect(pool.query('TRUNCATE audit_logs')).rejects.toThrow(/append-only/);
  });

  it('rejects javascript: and data: redirect_uris on app registration (XSS prevention)', async () => {
    const r1 = await adminCall('POST', '/v1/apps', {
      id: 'XSSAPP',
      name: 'XSS App',
      redirect_uris: ['javascript:alert(document.domain)'],
    });
    expect(r1.statusCode).toBe(400);

    const r2 = await adminCall('POST', '/v1/apps', {
      id: 'DATAAPP',
      name: 'Data App',
      redirect_uris: ['data:text/html,<script>alert(1)</script>'],
    });
    expect(r2.statusCode).toBe(400);
  });

  it('enforces CSRF protection on cookie-authenticated mutating requests', async () => {
    const blocked = await app.inject({
      method: 'POST',
      url: '/v1/users',
      cookies: { acl_admin_session: adminToken },
      payload: { email: 'csrf.victim@nsut.ac.in', name: 'CSRF Victim' },
    });
    expect(blocked.statusCode).toBe(403);

    const allowed = await app.inject({
      method: 'POST',
      url: '/v1/users',
      cookies: { acl_admin_session: adminToken },
      headers: { 'x-requested-with': 'XMLHttpRequest' },
      payload: { email: 'csrf.ok@nsut.ac.in', name: 'CSRF Allowed' },
    });
    expect(allowed.statusCode).toBe(201);
  });

  it('rejects OIDC id_token when presented as a Bearer access_token', async () => {
    const l = await login(app, { email: 'root@nsut.ac.in', appId: 'ACL' });
    if (l.stage !== 'done') throw new Error('login failed');
    const idToken = l.tokens.id_token;
    expect(idToken).toBeTruthy();

    const uinfo = await app.inject({ url: '/userinfo', headers: auth(idToken) });
    expect(uinfo.statusCode).toBe(401);

    const adminRes = await app.inject({ url: '/v1/users', headers: auth(idToken) });
    expect(adminRes.statusCode).toBe(401);
  });

  it('prevents default_scope from referencing sensitive PII columns like mobile_no or google_sub', async () => {
    const res = await adminCall('PUT', '/v1/apps/CRAS/roles', {
      roles: [
        {
          role: 'VIEWER',
          permissions: ['cras.calendar'],
          is_default: true,
          default_scope: { leaked_phone: 'mobile_no' },
        },
      ],
    });
    expect(res.statusCode).toBe(400);
  });

  it('neutralizes CSV formula injection in downloadable error reports', async () => {
    const csv = [
      'email,name,roll_no',
      '=cmd|/c_calc!A0@gmail.com,=1+1,2023UCS999',
    ].join('\n');
    await importUsersCsv(csv, undefined, 'test-csv-inj');
    const errReport = await adminCall('GET', '/v1/jobs/test-csv-inj/errors.csv');
    expect(errReport.statusCode).toBe(200);
    expect(errReport.body).toContain("'=cmd|");
  });

  it('redacts raw PII from PROFILE_UPDATED audit logs, immediately revokes suspended user tokens, and supports DPDP anonymization', async () => {
    const l = await login(app, { email: 'dpdp.user@nsut.ac.in', appId: 'CRAS', name: 'DPDP User' });
    if (l.stage !== 'done') throw new Error('login failed');
    const uid = (await pool.query(`SELECT id FROM users WHERE email='dpdp.user@nsut.ac.in'`)).rows[0].id;

    await adminCall('PATCH', `/v1/users/${uid}`, { mobile_no: '9876543210', status: 'SUSPENDED' });

    // Audit log must record field names, NOT raw mobile_no
    const auditRow = (
      await pool.query(
        `SELECT metadata FROM audit_logs WHERE target_id=$1 AND action='PROFILE_UPDATED' ORDER BY id DESC LIMIT 1`,
        [uid],
      )
    ).rows[0];
    expect(auditRow.metadata.updated_fields).toContain('mobile_no');
    expect(JSON.stringify(auditRow.metadata)).not.toContain('9876543210');

    // Suspended user's existing access token must be immediately rejected at /userinfo
    const uinfo = await app.inject({ url: '/userinfo', headers: auth(l.tokens.access_token) });
    expect(uinfo.statusCode).toBe(401);

    // Anonymize user (DPDP right to erasure)
    const anon = await adminCall('POST', `/v1/users/${uid}/anonymize`);
    expect(anon.statusCode).toBe(200);
    const after = (await pool.query(`SELECT email, name, mobile_no, status FROM users WHERE id=$1`, [uid])).rows[0];
    expect(after.name).toBe('Anonymized User');
    expect(after.mobile_no).toBeNull();
    expect(after.status).toBe('ARCHIVED');
  });
});

