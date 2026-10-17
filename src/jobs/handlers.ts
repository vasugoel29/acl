import { parse } from 'csv-parse/sync';
import { pool, tx } from '../db/pool.js';
import { escapeCsvCell, newId } from '../util.js';
import { audit } from '../audit.js';
import { bumpAclVersion } from '../acl/engine.js';
import { publishAclVersion, denyUserTokens } from '../tokens/access.js';
import { redis, keys } from '../redis.js';
import { isDomainAllowed } from '../auth/google.js';
import { startJobRecord, updateJobProgress, completeJobRecord, failJobRecord } from './tracker.js';

const int = (v: unknown) => {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number.parseInt(String(v).trim(), 10);
  return Number.isNaN(n) ? null : n;
};

export interface ImportErrorItem {
  row: number;
  email?: string;
  category: string;
  error: string;
}

export interface ImportResult {
  total: number;
  created: number;
  updated: number;
  failed: number;
  hasErrors: boolean;
  errorSummary: Record<string, number>;
  sampleErrors: ImportErrorItem[];
  // Backwards compatibility for existing unit tests
  errors: Array<{ row: number; error: string }>;
  jobId?: string;
}

function normalizeKey(k: string): string {
  return k.replace(/^\ufeff/, '').toLowerCase().replace(/[\s_\-.]+/g, '');
}

function sniffDelimiter(sample: string): string {
  const firstLine = sample.split(/\r?\n/)[0] || '';
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  const semicolons = (firstLine.match(/;/g) || []).length;
  if (tabs > commas && tabs > semicolons) return '\t';
  if (semicolons > commas && semicolons > tabs) return ';';
  return ',';
}

function extractMappedFields(raw: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    normalized[normalizeKey(k)] = typeof v === 'string' ? v.trim() : String(v ?? '').trim();
  }

  const find = (...aliases: string[]) => {
    for (const a of aliases) {
      if (normalized[a] !== undefined && normalized[a] !== '') return normalized[a];
    }
    return '';
  };

  return {
    email: find('nsutemailid', 'nsutemail', 'emailid', 'officialemail', 'studentemail', 'collegeemail', 'email', 'mail'),
    name: find('name', 'fullname', 'studentname', 'nameofstudent', 'facultyname', 'employeename', 'nameofemployee'),
    roll_no: find('studentrollno', 'rollno', 'rollnumber', 'roll', 'enrollmentno', 'regno'),
    twelve_digit_roll_no: find('twelvedigitrollno', 'twelvedigitroll', 'twelvedigit', 'twelvedigitrollnumber', '12digitrollno', '12digitroll'),
    degree: find('degree', 'course', 'program', 'programme'),
    dept: find('department', 'dept'),
    branch: find('branch', 'discipline', 'stream', 'department', 'dept'),
    semester: find('studentcurrentsem', 'currentsem', 'currentsemester', 'semester', 'sem'),
    section: find('section', 'sec'),
    group_no: find('group', 'groupno', 'grp', 'batchgroup'),
    batch_no: find('batchno', 'batchnum', 'batchnumber', 'batch'),
    year: find('year', 'academicyear', 'studyear', 'currentyear'),
    batch_year: find('batchyear', 'admissionyear', 'cohortyear'),
    employee_id: find('employeeid', 'empid', 'facultyid', 'code'),
    department: find('department', 'dept'),
    designation: find('designation', 'desig', 'title', 'post'),
    mobile_no: find('mobilenumber', 'mobile', 'mobileno', 'phone', 'phonenumber', 'contact', 'contactno'),
  };
}

/**
 * Enterprise Bulk CSV/TSV Import:
 * - Dynamic delimiter sniffing (comma, tab, semicolon) and BOM stripping
 * - Resilient column auto-mapping for NSUT ERP exports ('NSUT EMAIL ID', 'Student RollNo', etc.)
 * - Direct unified ingestion into users table with complete academic coordinates
 * - Batch year derived strictly from Roll Number prefix or batch_year column
 * - Stores full CSV failure report in Redis (downloadable via /v1/jobs/:id/errors.csv)
 */
export async function importUsersCsv(csv: string, actorId?: string, jobId?: string): Promise<ImportResult> {
  try {
    if (jobId) await startJobRecord(jobId);

    const cleanCsv = csv.replace(/^\ufeff/, '').trim();
    const delimiter = sniffDelimiter(cleanCsv);

    let rawRows: Record<string, string>[] = [];
    try {
      rawRows = parse(cleanCsv, {
        delimiter,
        columns: (headers: string[]) => headers.map((h) => h.replace(/^\ufeff/, '').trim()),
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      });
    } catch (err: any) {
      throw new Error(`Invalid CSV syntax: ${err.message}`);
    }

    const total = rawRows.length;
    if (jobId) await startJobRecord(jobId, total);
  let created = 0;
  let updated = 0;
  const allErrors: ImportErrorItem[] = [];
  const errorSummary: Record<string, number> = {};

  const recordError = (row: number, category: string, error: string, email?: string) => {
    allErrors.push({ row, category, error, email });
    errorSummary[category] = (errorSummary[category] ?? 0) + 1;
  };

    // Process in batches of 250 within a single chunk transaction using SAVEPOINT per row
    const CHUNK_SIZE = 250;
    for (let c = 0; c < total; c += CHUNK_SIZE) {
      const chunk = rawRows.slice(c, c + CHUNK_SIZE);

      await tx(async (dbClient) => {
        for (let i = 0; i < chunk.length; i++) {
          const rowNo = c + i + 2; // header is row 1
          const f = extractMappedFields(chunk[i]);

          // Fallback: if email column is empty, derive from roll number
          let email = f.email ? f.email.toLowerCase() : '';
          if (!email && f.roll_no) {
            email = `${f.roll_no.toLowerCase()}@nsut.ac.in`;
          }

          if (!email) {
            recordError(rowNo, 'MISSING_EMAIL', 'Email address is required');
            continue;
          }

          if (!isDomainAllowed(email)) {
            recordError(rowNo, 'INVALID_DOMAIN', `email must end with @nsut.ac.in or @nsit.ac.in`, email);
            continue;
          }

          if (!f.name) {
            recordError(rowNo, 'MISSING_NAME', 'name required', email);
            continue;
          }

          // Academic coordinate derivations - no default fallbacks, missing fields remain null
          const semDigits = f.semester ? f.semester.replace(/\D/g, '') : '';
          const semester = semDigits ? Math.max(1, Math.min(10, parseInt(semDigits, 10))) : null;

          const yearDigits = f.year ? f.year.replace(/\D/g, '') : '';
          let year: number | null = yearDigits ? Math.max(1, Math.min(5, parseInt(yearDigits, 10))) : null;
          if (year === null && semester !== null) {
            year = Math.max(1, Math.min(5, Math.ceil(semester / 2)));
          }

          const degree = f.degree ? f.degree.trim() : null;
          const dept = f.dept ? f.dept.trim() : (f.department ? f.department.trim() : null);
          const branch = f.branch ? f.branch.trim() : null;
          const rollNo = f.roll_no ? f.roll_no.toUpperCase() : null;
          const empId = f.employee_id ? f.employee_id.trim() : null;
          const designation = f.designation ? f.designation.trim() : null;
          const mobileNo = f.mobile_no ? f.mobile_no.trim() : null;

          // Twelve-digit roll number (BIGINT)
          const clean12 = f.twelve_digit_roll_no ? f.twelve_digit_roll_no.replace(/\D/g, '') : '';
          const twelveDigitRollNo = clean12 ? clean12 : null;

          // Derive batch_year strictly from roll number or explicit batch_year column
          let batchYear: number | null = null;
          if (rollNo) {
            const m = rollNo.match(/^(\d{4})/);
            if (m) batchYear = parseInt(m[1], 10);
          }
          if (!batchYear && twelveDigitRollNo) {
            const m12 = twelveDigitRollNo.match(/^(\d{4})/);
            if (m12) batchYear = parseInt(m12[1], 10);
          }
          if (!batchYear && f.batch_year) {
            const parsedBatch = parseInt(f.batch_year, 10);
            if (!isNaN(parsedBatch) && parsedBatch > 2000) batchYear = parsedBatch;
          }

          const secDigits = f.section ? f.section.replace(/\D/g, '') : '';
          const section = secDigits ? parseInt(secDigits, 10) : null;

          const grpDigits = f.group_no ? f.group_no.replace(/\D/g, '') : '';
          const groupNo = grpDigits ? parseInt(grpDigits, 10) : null;

          const batchDigits = f.batch_no ? f.batch_no.replace(/\D/g, '') : '';
          const batchNo = batchDigits ? parseInt(batchDigits, 10) : null;

          await dbClient.query('SAVEPOINT row_sp');
          try {
            const existing = (await dbClient.query(`SELECT id FROM users WHERE email=$1`, [email])).rows[0];
            const id = existing?.id ?? newId('usr');

            if (existing) {
              await dbClient.query(
                `UPDATE users SET
                   name = $2,
                   dept = COALESCE($3, dept),
                   branch = COALESCE($4, branch),
                   degree = COALESCE($5, degree),
                   roll_no = COALESCE($6, roll_no),
                   twelve_digit_roll_no = COALESCE($7, twelve_digit_roll_no),
                   year = COALESCE($8, year),
                   semester = COALESCE($9, semester),
                   section = COALESCE($10, section),
                   group_no = COALESCE($11, group_no),
                   batch_no = COALESCE($12, batch_no),
                   batch_year = COALESCE($13, batch_year),
                   employee_id = COALESCE($14, employee_id),
                   designation = COALESCE($15, designation),
                   mobile_no = COALESCE($16, mobile_no),
                   acl_version = COALESCE(acl_version, 1) + 1,
                   updated_at = now()
                 WHERE id = $1`,
                [id, f.name, dept, branch, degree, rollNo, twelveDigitRollNo, year, semester, section, groupNo, batchNo, batchYear, empId, designation, mobileNo],
              );
              updated++;
            } else {
              await dbClient.query(
                `INSERT INTO users (
                   id, email, name,
                   dept, branch, degree, roll_no, twelve_digit_roll_no,
                   year, semester, section, group_no, batch_no, batch_year,
                   employee_id, designation, mobile_no
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
                [id, email, f.name, dept, branch, degree, rollNo, twelveDigitRollNo, year, semester, section, groupNo, batchNo, batchYear, empId, designation, mobileNo],
              );
              created++;
            }
            await dbClient.query('RELEASE SAVEPOINT row_sp');
          } catch (e: any) {
            await dbClient.query('ROLLBACK TO SAVEPOINT row_sp');
            await dbClient.query('RELEASE SAVEPOINT row_sp');
            const errDetail = e.code === '23505' ? `duplicate value (${e.detail ?? 'unique violation'})` : e.message;
            recordError(rowNo, 'DATABASE_ERROR', errDetail, email);
          }
        }
      });

      if (jobId) {
        await updateJobProgress({
          id: jobId,
          processedRows: Math.min(c + CHUNK_SIZE, total),
          totalRows: total,
          createdCount: created,
          updatedCount: updated,
          failedCount: allErrors.length,
        });
      }

      // Yield to event loop between chunks so HTTP handlers stay responsive
      await new Promise((r) => setImmediate(r));
    }

    // Generate downloadable error CSV if any rows failed (with CSV formula injection protection)
    if (allErrors.length > 0 && jobId) {
      const errorCsvHeader = 'row,email,category,error\n';
      const errorCsvRows = allErrors
        .map((e) => [e.row, escapeCsvCell(e.email ?? ''), escapeCsvCell(e.category), escapeCsvCell(e.error)].join(','))
        .join('\n');
      await redis.set(`job:errors:${jobId}`, errorCsvHeader + errorCsvRows, 'EX', 172800); // 48-hour retention
    }

    await audit({
      actorId,
      action: 'USERS_IMPORTED',
      metadata: { total, created, updated, failed: allErrors.length, categories: errorSummary },
    });

    if (jobId) {
      await completeJobRecord({
        id: jobId,
        totalRows: total,
        processedRows: total,
        createdCount: created,
        updatedCount: updated,
        failedCount: allErrors.length,
        metadata: {
          errorSummary,
          hasErrors: allErrors.length > 0,
        },
      });
    }

    return {
      total,
      created,
      updated,
      failed: allErrors.length,
      hasErrors: allErrors.length > 0,
      errorSummary,
      sampleErrors: allErrors.slice(0, 50),
      errors: allErrors.map((e) => ({ row: e.row, error: e.error })),
      jobId,
    };
  } catch (err: any) {
    if (jobId) await failJobRecord(jobId, err.message);
    throw err;
  }
}

export interface RolloverResult {
  advanced: number;
  graduated: number;
  scopedAssignmentsExpired: number;
}

import { config } from '../config.js';

const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

const RENEW_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("expire", KEYS[1], ARGV[2])
else
  return 0
end
`;

/**
 * Semester rollover: semester += 1; students beyond maxSemester graduate (ARCHIVED) and their
 * sessions are revoked; semester-scoped assignments expire so reps are re-confirmed (spec Flow 5).
 */
export async function semesterRollover(opts: { maxSemester?: number } = {}, actorId?: string, jobId?: string): Promise<RolloverResult> {
  const lockToken = crypto.randomUUID();
  const lockKey = keys.rolloverLock();
  const lockTtlSec = 300;
  const acquired = await redis.set(lockKey, lockToken, 'EX', lockTtlSec, 'NX');
  if (!acquired) {
    const err = new Error('Another semester rollover is currently in progress');
    if (jobId) await failJobRecord(jobId, err.message);
    throw err;
  }
  const renewTimer = setInterval(async () => {
    try {
      await redis.eval(RENEW_LOCK_SCRIPT, 1, lockKey, lockToken, String(lockTtlSec));
    } catch {}
  }, Math.max(1000, (lockTtlSec * 1000) / 3));

  try {
    if (jobId) await startJobRecord(jobId);

    const max = opts.maxSemester ?? 8;
    const out = await tx(async (c) => {
      const graduating = (
        await c.query(`SELECT id FROM users WHERE status = 'ACTIVE' AND semester IS NOT NULL AND semester >= $1`, [max])
      ).rows.map((r) => r.id as string);
      const advancing = (
        await c.query(`SELECT id FROM users WHERE status = 'ACTIVE' AND semester IS NOT NULL AND semester < $1`, [max])
      ).rows.map((r) => r.id as string);

      if (advancing.length) {
        await c.query(
          `UPDATE users SET semester = semester + 1, year = CEIL((semester + 1)::numeric / 2), updated_at = now()
            WHERE id = ANY($1)`,
          [advancing],
        );
      }
      if (graduating.length) {
        await c.query(`UPDATE users SET status='ARCHIVED', updated_at=now() WHERE id = ANY($1)`, [graduating]);
        await c.query(`UPDATE sessions SET revoked_at=now() WHERE user_id = ANY($1) AND revoked_at IS NULL`, [graduating]);
      }
      const expired = await c.query(
        `UPDATE user_app_roles SET expires_at = now()
          WHERE scope ? 'semester' AND (expires_at IS NULL OR expires_at > now())
            AND user_id = ANY($1) RETURNING user_id`,
        [[...advancing, ...graduating]],
      );
      const affected = [...new Set([...advancing, ...graduating])];
      let updatedUsers: { id: string; acl_version: number }[] = [];
      if (affected.length) {
        const bumpRes = await c.query(
          `UPDATE users SET acl_version = acl_version + 1 WHERE id = ANY($1) RETURNING id, acl_version`,
          [affected],
        );
        updatedUsers = bumpRes.rows.map((r) => ({ id: r.id as string, acl_version: Number(r.acl_version) }));
      }
      return { affected, updatedUsers, graduatedIds: graduating, graduated: graduating.length, advanced: advancing.length, expired: expired.rowCount ?? 0 };
    });

    if (out.updatedUsers.length || out.graduatedIds.length) {
      const pipeline = redis.pipeline();
      for (const u of out.updatedUsers) {
        pipeline.set(keys.aclVersion(u.id), String(u.acl_version), 'EX', config.accessTokenTtlSec * 2);
      }
      const revokedAt = String(Math.floor(Date.now() / 1000));
      for (const id of out.graduatedIds) {
        pipeline.set(keys.denyUser(id), revokedAt, 'EX', Math.max(config.accessTokenTtlSec, 1));
      }
      await pipeline.exec();
    }

    await audit({ actorId, action: 'SEMESTER_ROLLOVER', metadata: { advanced: out.advanced, graduated: out.graduated, expired: out.expired } });

    if (jobId) {
      await completeJobRecord({
        id: jobId,
        totalRows: out.advanced + out.graduated,
        processedRows: out.advanced + out.graduated,
        updatedCount: out.advanced,
        createdCount: 0,
        failedCount: 0,
        metadata: { advanced: out.advanced, graduated: out.graduated, expired: out.expired },
      });
    }

    return { advanced: out.advanced, graduated: out.graduated, scopedAssignmentsExpired: out.expired };
  } catch (err: any) {
    if (jobId) await failJobRecord(jobId, err.message);
    throw err;
  } finally {
    clearInterval(renewTimer);
    await redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, lockToken).catch(() => {});
  }
}

/**
 * Remove expired role assignments (bumping affected users' ACL versions) and prune expired
 * auth_codes and sessions so database tables stay bounded (spec §2.11).
 */
export async function roleExpirySweep() {
  const del = await pool.query(`DELETE FROM user_app_roles WHERE expires_at IS NOT NULL AND expires_at <= now() RETURNING user_id, app_id, role`);
  const users = [...new Set(del.rows.map((r) => r.user_id as string))];
  for (const id of users) {
    const v = await bumpAclVersion(id);
    if (v) await publishAclVersion(id, v);
  }
  if (del.rowCount) await audit({ action: 'ROLES_EXPIRED', metadata: { count: del.rowCount } });

  // Prune expired authorization codes (> 1 hour old) and expired/revoked sessions (> 7 days old)
  const [prunedCodes, prunedSessions] = await Promise.all([
    pool.query(`DELETE FROM auth_codes WHERE expires_at < now() - interval '1 hour'`),
    pool.query(
      `DELETE FROM sessions
        WHERE expires_at < now() - interval '7 days'
           OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')`,
    ),
  ]);

  return {
    removed: del.rowCount ?? 0,
    prunedAuthCodes: prunedCodes.rowCount ?? 0,
    prunedSessions: prunedSessions.rowCount ?? 0,
  };
}
