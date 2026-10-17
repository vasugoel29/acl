import { pool } from '../db/pool.js';
import { redis } from '../redis.js';
import { escapeCsvCell } from '../util.js';
import { startJobRecord, updateJobProgress, completeJobRecord, failJobRecord } from './tracker.js';

export interface ExportFilterOpts {
  dept?: string;
  status?: string;
}

export async function exportUsersCsv(
  opts: ExportFilterOpts = {},
  actorId?: string,
  jobId?: string,
): Promise<{ total: number; key?: string }> {
  try {
    if (jobId) await startJobRecord(jobId, undefined, 'EXPORT');

    const conditions: string[] = [];
    const values: any[] = [];
    if (opts.dept) {
      values.push(opts.dept);
      conditions.push(`dept = $${values.length}`);
    }
    if (opts.status) {
      values.push(opts.status);
      conditions.push(`status = $${values.length}`);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Total count for progress tracking
    const countRes = await pool.query(`SELECT count(*)::int as count FROM users ${whereClause}`, values);
    const total = countRes.rows[0]?.count ?? 0;

    if (jobId) await startJobRecord(jobId, total, 'EXPORT');

    const header = [
      'Exam Year',
      'Degree',
      'Department',
      'Student RollNo',
      'Name',
      'Student Current Sem',
      'Twelve Digit Roll No',
      'NSUT EMAIL ID',
      'Status',
    ].join(',');

    const csvLines: string[] = [header];

    // Stream query in pages of 500
    const PAGE_SIZE = 500;
    let processed = 0;

    const currentYear = new Date().getFullYear();

    for (let offset = 0; offset < total; offset += PAGE_SIZE) {
      const pageRes = await pool.query(
        `SELECT id, name, email, roll_no, twelve_digit_roll_no, dept, branch, degree, year, semester, section, group_no, batch_no, batch_year, status
         FROM users
         ${whereClause}
         ORDER BY id ASC
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, PAGE_SIZE, offset],
      );

      for (const u of pageRes.rows) {
        const row = [
          escapeCsvCell(u.batch_year ?? (u.year ? currentYear - (4 - u.year) : '')),
          escapeCsvCell(u.degree ?? ''),
          escapeCsvCell(u.dept ?? u.branch ?? ''),
          escapeCsvCell(u.roll_no ?? ''),
          escapeCsvCell(u.name ?? ''),
          escapeCsvCell(u.semester ?? ''),
          escapeCsvCell(u.twelve_digit_roll_no ? String(u.twelve_digit_roll_no) : ''),
          escapeCsvCell(u.email ?? ''),
          escapeCsvCell(u.status ?? 'ACTIVE'),
        ];
        csvLines.push(row.join(','));
        processed++;
      }

      if (jobId) {
        await updateJobProgress({
          id: jobId,
          processedRows: processed,
          totalRows: total,
        });
      }
    }

    const fullCsv = csvLines.join('\n');
    const redisKey = `job:export:${jobId ?? 'latest'}`;
    // Retain export in Redis for 48 hours (172,800 seconds)
    await redis.set(redisKey, fullCsv, 'EX', 172800);

    if (jobId) {
      await completeJobRecord({
        id: jobId,
        totalRows: total,
        processedRows: processed,
        metadata: {
          key: redisKey,
          filename: `campus_directory_export_${Date.now()}.csv`,
          totalRecords: total,
        },
      });
    }

    return { total, key: redisKey };
  } catch (err: any) {
    if (jobId) await failJobRecord(jobId, err.message);
    throw err;
  }
}
