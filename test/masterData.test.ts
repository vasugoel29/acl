import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server.js';
import { pool } from '../src/db/pool.js';
import { redis } from '../src/redis.js';

describe('Master Reference Data APIs', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    redis.disconnect();
  });

  it('GET /v1/departments returns active departments', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/departments',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.departments)).toBe(true);
    expect(body.departments.length).toBeGreaterThan(15);
    const cse = body.departments.find((d: any) => d.code === 'CSE');
    expect(cse).toBeDefined();
    expect(cse.name).toBe('Computer Science and Engineering');
  });

  it('GET /v1/branches filters by department', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/branches?dept=CSE',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.branches)).toBe(true);
    const branchCodes = body.branches.map((b: any) => b.code);
    expect(branchCodes).toContain('CSE');
    expect(branchCodes).toContain('CSAI');
    expect(branchCodes).toContain('CSDS');
    expect(branchCodes).toContain('MAC');
  });

  it('GET /v1/programs returns degree and branch metadata', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/programs?degree=BTECH&dept=CSE',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.programs.length).toBeGreaterThan(0);
    const p = body.programs[0];
    expect(p.degree_code).toBe('BTECH');
    expect(p.dept_code).toBe('CSE');
    expect(p.branch_code).toBeDefined();
  });

  it('GET /v1/terms/current returns active 2026-EVEN semester', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/terms/current',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.code).toBe('2026-EVEN');
    expect(body.is_current).toBe(true);
  });

  it('GET /v1/designations returns faculty and staff designations', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/designations',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.designations.length).toBeGreaterThanOrEqual(6);
    const prof = body.designations.find((d: any) => d.code === 'PROF');
    expect(prof).toBeDefined();
    expect(prof.category).toBe('FACULTY');
  });

  it('verifies IEVD branch is under department MS and IEVD department is removed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/branches?dept=MS',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const branchCodes = body.branches.map((b: any) => b.code);
    expect(branchCodes).toContain('IEVD');

    const deptRes = await app.inject({
      method: 'GET',
      url: '/v1/departments',
    });
    const depts = deptRes.json().departments.map((d: any) => d.code);
    expect(depts).not.toContain('IEVD');
  });

  it('verifies app_resources table exists and contains seeded permissions', async () => {
    const res = await pool.query(
      `SELECT count(*)::int AS count 
       FROM app_resources 
       WHERE app_id = 'app_01JCRAS0000000000000000000' 
          OR app_id IN (SELECT id FROM applications WHERE client_id = 'CRAS')`,
    );
    expect(res.rows[0].count).toBeGreaterThan(0);
  });

  it('verifies sync_user_year trigger automatically computes year from semester', async () => {
    const testUserId = 'usr_trigger_test';
    await pool.query(
      `INSERT INTO users (id, email, name, semester)
       VALUES ($1, 'test.year.trigger@nsut.ac.in', 'Trigger Test', 5)
       ON CONFLICT (id) DO UPDATE SET semester = 5`,
      [testUserId],
    );
    const res = await pool.query(`SELECT year, semester FROM users WHERE id = $1`, [testUserId]);
    expect(res.rows[0].semester).toBe(5);
    expect(res.rows[0].year).toBe(3); // ceil(5/2) = 3

    await pool.query(`UPDATE users SET semester = 8 WHERE id = $1`, [testUserId]);
    const res2 = await pool.query(`SELECT year, semester FROM users WHERE id = $1`, [testUserId]);
    expect(res2.rows[0].year).toBe(4); // ceil(8/2) = 4

    // cleanup
    await pool.query(`DELETE FROM users WHERE id = $1`, [testUserId]);
  });

  it('verifies v_users_directory view is functional', async () => {
    const res = await pool.query(`SELECT count(*)::int AS count FROM v_users_directory`);
    expect(res.rows[0].count).toBeGreaterThanOrEqual(0);
  });
});

