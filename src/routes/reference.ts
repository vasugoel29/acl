import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../db/pool.js';
import { z } from 'zod';

export async function referenceRoutes(app: FastifyInstance) {
  const setCacheHeaders = (reply: FastifyReply) => {
    reply.header('cache-control', 'public, max-age=300');
  };

  /**
   * GET /v1/departments
   * Returns all departments or filters by status (?status=ACTIVE)
   */
  const handleDepartments = async (req: FastifyRequest, reply: FastifyReply) => {
    const q = z.object({ status: z.enum(['ACTIVE', 'ARCHIVED']).optional() }).parse(req.query ?? {});
    const r = await pool.query(
      `SELECT code, name, status, created_at, updated_at
       FROM departments
       WHERE ($1::text IS NULL OR status = $1)
       ORDER BY name ASC`,
      [q.status ?? null],
    );
    setCacheHeaders(reply);
    return {
      departments: r.rows,
      names: r.rows.map((x) => x.name),
    };
  };

  app.get('/v1/departments', handleDepartments);
  app.get('/v1/reference/departments', handleDepartments);

  /**
   * GET /v1/degrees
   * Returns all degree qualifications (BTECH, MTECH, etc.)
   */
  app.get('/v1/degrees', async (req: FastifyRequest, reply: FastifyReply) => {
    const q = z.object({ status: z.enum(['ACTIVE', 'ARCHIVED']).optional() }).parse(req.query ?? {});
    const r = await pool.query(
      `SELECT code, name, duration_years, status, created_at, updated_at
       FROM degrees
       WHERE ($1::text IS NULL OR status = $1)
       ORDER BY duration_years DESC NULLS LAST, name ASC`,
      [q.status ?? null],
    );
    setCacheHeaders(reply);
    return { degrees: r.rows };
  });

  /**
   * GET /v1/branches
   * Returns all branches or filters by dept (?dept=CSE) or status (?status=ACTIVE)
   */
  app.get('/v1/branches', async (req: FastifyRequest, reply: FastifyReply) => {
    const q = z
      .object({
        dept: z.string().optional(),
        status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
      })
      .parse(req.query ?? {});

    const r = await pool.query(
      `SELECT b.code, b.dept_code, d.name AS dept_name, b.name, b.status, b.created_at, b.updated_at
       FROM branches b
       JOIN departments d ON d.code = b.dept_code
       WHERE ($1::text IS NULL OR b.dept_code = $1)
         AND ($2::text IS NULL OR b.status = $2)
       ORDER BY b.dept_code ASC, b.name ASC`,
      [q.dept ?? null, q.status ?? null],
    );
    setCacheHeaders(reply);
    return { branches: r.rows };
  });

  /**
   * GET /v1/programs
   * Returns active degree + branch pairings that students enroll in
   */
  app.get('/v1/programs', async (req: FastifyRequest, reply: FastifyReply) => {
    const q = z
      .object({
        degree: z.string().optional(),
        dept: z.string().optional(),
        branch: z.string().optional(),
        status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
      })
      .parse(req.query ?? {});

    const r = await pool.query(
      `SELECT p.id,
              p.degree_code,
              deg.name AS degree_name,
              deg.duration_years,
              p.branch_code,
              b.name AS branch_name,
              b.dept_code,
              d.name AS dept_name,
              p.status,
              p.created_at
       FROM programs p
       JOIN degrees deg ON deg.code = p.degree_code
       JOIN branches b ON b.code = p.branch_code
       JOIN departments d ON d.code = b.dept_code
       WHERE ($1::text IS NULL OR p.degree_code = $1)
         AND ($2::text IS NULL OR b.dept_code = $2)
         AND ($3::text IS NULL OR p.branch_code = $3)
         AND ($4::text IS NULL OR p.status = $4)
       ORDER BY deg.duration_years DESC NULLS LAST, d.name ASC, b.name ASC`,
      [q.degree ?? null, q.dept ?? null, q.branch ?? null, q.status ?? null],
    );
    setCacheHeaders(reply);
    return { programs: r.rows };
  });

  /**
   * GET /v1/terms
   * Returns all academic terms
   */
  app.get('/v1/terms', async (_req: FastifyRequest, reply: FastifyReply) => {
    const r = await pool.query(
      `SELECT code, name, start_date, end_date, is_current, created_at
       FROM academic_terms
       ORDER BY start_date DESC`,
    );
    setCacheHeaders(reply);
    return { terms: r.rows };
  });

  /**
   * GET /v1/terms/current
   * Returns the current active academic semester / term
   */
  app.get('/v1/terms/current', async (_req: FastifyRequest, reply: FastifyReply) => {
    const r = await pool.query(
      `SELECT code, name, start_date, end_date, is_current, created_at
       FROM academic_terms
       WHERE is_current = true
       LIMIT 1`,
    );
    setCacheHeaders(reply);
    if (!r.rows[0]) {
      return reply.code(404).send({ error: 'no_current_term', message: 'No active academic term configured' });
    }
    return r.rows[0];
  });

  /**
   * GET /v1/designations
   * Returns faculty and staff designations
   */
  app.get('/v1/designations', async (req: FastifyRequest, reply: FastifyReply) => {
    const q = z
      .object({
        category: z.enum(['FACULTY', 'STAFF']).optional(),
        status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
      })
      .parse(req.query ?? {});

    const r = await pool.query(
      `SELECT code, name, category, rank, status, created_at, updated_at
       FROM designations
       WHERE ($1::text IS NULL OR category = $1)
         AND ($2::text IS NULL OR status = $2)
       ORDER BY rank ASC, name ASC`,
      [q.category ?? null, q.status ?? null],
    );
    setCacheHeaders(reply);
    return { designations: r.rows };
  });
}
