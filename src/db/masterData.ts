import type { PoolClient } from 'pg';

/**
 * Master reference data. Stable codes are the primary keys; `users` references
 * them via dept_code / program_id / designation_code.
 */

export const DEPARTMENTS: { code: string; name: string }[] = [
  { code: 'CSE', name: 'Computer Science and Engineering' },
  { code: 'CSE_EAST', name: 'Computer Science and Engineering (East)' },
  { code: 'IT', name: 'Information Technology' },
  { code: 'ECE', name: 'Electronics and Communication Engineering' },
  { code: 'ECE_EAST', name: 'Electronics and Communication Engineering (East)' },
  { code: 'EE', name: 'Electrical Engineering' },
  { code: 'ICE', name: 'Instrumentation and Control Engineering' },
  { code: 'ME', name: 'Mechanical Engineering' },
  { code: 'ME_WEST', name: 'Mechanical Engineering (West)' },
  { code: 'CIVIL', name: 'Civil Engineering' },
  { code: 'BIO', name: 'Biological Sciences and Engineering' },
  { code: 'MS', name: 'Management Studies' },
  { code: 'DESIGN', name: 'Design' },
  { code: 'ARCH', name: 'Architecture and Planning' },
  { code: 'HSS', name: 'Humanities and Social Sciences' },
  { code: 'MATH', name: 'Mathematics' },
  { code: 'PHY', name: 'Physics' },
  { code: 'CHEM', name: 'Chemistry' },
  { code: 'LIBRARY', name: 'Central Library' },
  { code: 'EXAM_CELL', name: 'Exam Cell' },
];

export const DEGREES: { code: string; name: string; years: number | null; aliases: string[] }[] = [
  { code: 'BTECH', name: 'B.Tech', years: 4, aliases: ['B.Tech.'] },
  { code: 'BTECH_LATERAL', name: 'B.Tech (Lateral Entry)', years: 3, aliases: ['B.Tech.(Lateral)'] },
  { code: 'MTECH', name: 'M.Tech (Full Time)', years: 2, aliases: ['M.Tech (FULL TIME)'] },
  { code: 'PHD', name: 'Ph.D', years: null, aliases: ['Ph.D'] },
  { code: 'MBA', name: 'MBA', years: 2, aliases: ['MBA'] },
  { code: 'BBA', name: 'BBA', years: 3, aliases: ['BBA'] },
  { code: 'BBA_HONS', name: 'BBA (Honours)', years: 4, aliases: ['BBA (HONOURS)'] },
  { code: 'IBBA_MBA_IEV', name: 'Integrated BBA-MBA (IEV)', years: 5, aliases: ['Integrated BBA-MBA IEV'] },
  { code: 'BARCH', name: 'Bachelor of Architecture', years: 5, aliases: ['BACHELOR OF ARCHITECTURE'] },
  { code: 'BDES', name: 'Bachelor of Design', years: 4, aliases: ['BACHELOR OF DESIGN'] },
  { code: 'MA', name: 'Master of Arts', years: 2, aliases: ['MASTER OF ARTS'] },
  { code: 'MSC', name: 'Master of Science', years: 2, aliases: ['MASTER OF SCIENCE'] },
];

export const BRANCHES: { code: string; dept: string; name: string }[] = [
  // CSE
  { code: 'CSE', dept: 'CSE', name: 'Computer Science and Engineering' },
  { code: 'CSAI', dept: 'CSE', name: 'CSE (Artificial Intelligence)' },
  { code: 'CSDS', dept: 'CSE', name: 'CSE (Data Science)' },
  { code: 'MAC', dept: 'CSE', name: 'Mathematics and Computing' },
  // CSE East
  { code: 'CSE_EAST', dept: 'CSE_EAST', name: 'Computer Science and Engineering (East)' },
  { code: 'CSAI_EAST', dept: 'CSE_EAST', name: 'CSE (Artificial Intelligence) (East)' },
  // IT
  { code: 'IT', dept: 'IT', name: 'Information Technology' },
  { code: 'ITNS', dept: 'IT', name: 'IT (Network and Information Security)' },
  { code: 'GEO', dept: 'IT', name: 'Geoinformatics' },
  // ECE
  { code: 'ECE', dept: 'ECE', name: 'Electronics and Communication Engineering' },
  { code: 'ECAM', dept: 'ECE', name: 'ECE (Advanced Communication and Microelectronics)' },
  { code: 'ECVL', dept: 'ECE', name: 'ECE (VLSI and Embedded Systems)' },
  { code: 'ECAI', dept: 'ECE', name: 'ECE (Artificial Intelligence and IoT)' },
  // ECE East
  { code: 'ECE_EAST', dept: 'ECE_EAST', name: 'Electronics and Communication Engineering (East)' },
  // EE & ICE
  { code: 'EE', dept: 'EE', name: 'Electrical Engineering' },
  { code: 'ICE', dept: 'ICE', name: 'Instrumentation and Control Engineering' },
  // ME & ME West
  { code: 'ME', dept: 'ME', name: 'Mechanical Engineering' },
  { code: 'MPAE', dept: 'ME', name: 'Manufacturing Processes and Automation Engineering' },
  { code: 'ME_WEST', dept: 'ME_WEST', name: 'Mechanical Engineering (West)' },
  { code: 'MEEV', dept: 'ME_WEST', name: 'Mechanical Engineering (Electric Vehicles)' },
  // Civil & Bio
  { code: 'CIVIL', dept: 'CIVIL', name: 'Civil Engineering' },
  { code: 'BT', dept: 'BIO', name: 'Biotechnology' },
  // Sciences
  { code: 'EP', dept: 'PHY', name: 'Engineering Physics' },
  { code: 'MATH', dept: 'MATH', name: 'Mathematics' },
  { code: 'PHY', dept: 'PHY', name: 'Physics' },
  { code: 'CHEM', dept: 'CHEM', name: 'Chemistry' },
  // Management & Design & Architecture & HSS
  { code: 'MS', dept: 'MS', name: 'Management Studies' },
  { code: 'BBA', dept: 'MS', name: 'BBA' },
  { code: 'BBA_HONS', dept: 'MS', name: 'BBA (Honours)' },
  { code: 'MBA', dept: 'MS', name: 'MBA' },
  { code: 'IEVD', dept: 'MS', name: 'Innovation and Entrepreneurship Venture Development' },
  { code: 'DESIGN', dept: 'DESIGN', name: 'Design' },
  { code: 'BDES', dept: 'DESIGN', name: 'Bachelor of Design' },
  { code: 'BDES_PD', dept: 'DESIGN', name: 'Bachelor of Design (Product Design)' },
  { code: 'BDES_FT', dept: 'DESIGN', name: 'Bachelor of Design (Fashion Technology)' },
  { code: 'BARCH', dept: 'ARCH', name: 'Bachelor of Architecture' },
  { code: 'HSS', dept: 'HSS', name: 'Humanities and Social Sciences' },
  { code: 'MA', dept: 'HSS', name: 'Master of Arts' },
  { code: 'PSYCH', dept: 'HSS', name: 'Applied Psychology' },
  { code: 'ENGLISH', dept: 'HSS', name: 'English' },
];

const BTECH_BRANCHES = [
  'CSE', 'CSAI', 'CSDS', 'MAC', 'CSE_EAST', 'CSAI_EAST', 'IT', 'ITNS', 'GEO', 'ECE', 'ECAM',
  'ECVL', 'ECAI', 'ECE_EAST', 'EE', 'ICE', 'ME', 'MPAE', 'ME_WEST', 'MEEV', 'CIVIL', 'BT', 'EP',
];

export const PROGRAMS: Record<string, string[]> = {
  BTECH: BTECH_BRANCHES,
  BTECH_LATERAL: ['CIVIL', 'GEO', 'MEEV', 'ME_WEST', 'CSE', 'IT', 'ECE'],
  MTECH: ['CSE', 'CSAI_EAST', 'ECVL', 'ECE_EAST', 'EE', 'ME', 'CIVIL', 'BT', 'IT'],
  MBA: ['MBA'],
  BBA: ['BBA'],
  BBA_HONS: ['BBA_HONS'],
  IBBA_MBA_IEV: ['IEVD'],
  BARCH: ['BARCH'],
  BDES: ['BDES', 'BDES_PD', 'BDES_FT'],
  MA: ['MA', 'PSYCH', 'ENGLISH'],
  MSC: ['MATH', 'PHY', 'CHEM'],
  PHD: [
    'CSE', 'CSE_EAST', 'IT', 'ECE', 'ECE_EAST', 'EE', 'ICE', 'ME', 'ME_WEST',
    'CIVIL', 'BT', 'MATH', 'PHY', 'CHEM', 'MS', 'DESIGN', 'HSS', 'IEVD',
  ],
};

export const DESIGNATIONS: { code: string; name: string; category: 'FACULTY' | 'STAFF'; rank: number }[] = [
  { code: 'PROF', name: 'Professor', category: 'FACULTY', rank: 10 },
  { code: 'ASSOC_PROF', name: 'Associate Professor', category: 'FACULTY', rank: 20 },
  { code: 'ASST_PROF', name: 'Assistant Professor', category: 'FACULTY', rank: 30 },
  { code: 'PROF_VISITOR', name: 'Professor of Visitor', category: 'FACULTY', rank: 15 },
  { code: 'CONTROLLER_EXAMS', name: 'Controller of Examinations', category: 'STAFF', rank: 5 },
  { code: 'ASST_LIBRARIAN', name: 'Assistant Librarian', category: 'STAFF', rank: 40 },
];

export const TERMS: { code: string; name: string; startDate: string; endDate: string; isCurrent: boolean }[] = [
  { code: '2026-EVEN', name: 'Even Semester 2025-2026', startDate: '2026-01-05', endDate: '2026-05-31', isCurrent: true },
  { code: '2025-ODD', name: 'Odd Semester 2025-2026', startDate: '2025-08-01', endDate: '2025-12-24', isCurrent: false },
];

const norm = (s: string) =>
  s.toLowerCase().replace(/&/g, 'and').replace(/^department of /, '').replace(/[^a-z0-9]/g, '');

const DEPT_ALIASES: Record<string, string> = {
  ...Object.fromEntries(DEPARTMENTS.map((d) => [norm(d.name), d.code])),
  geoinformatics: 'IT',
  examinationsection: 'EXAM_CELL',
  mechanicalengineeringandelectricalvehicle: 'ME_WEST',
  innovationandentrepreneurshipventuredevelopment: 'MS',
  ievd: 'MS',
};

const DEGREE_ALIASES: Record<string, string> = Object.fromEntries(
  DEGREES.flatMap((d) => d.aliases.map((a) => [a, d.code])),
);

const DESIGNATION_ALIASES: Record<string, string> = Object.fromEntries(
  DESIGNATIONS.map((d) => [d.name, d.code]),
);

/** Mapping of roll number letter code to { degree_code, branch_code } */
export const ROLL_CODE_MAP: Record<string, { degree: string; branch: string }> = {
  // B.Tech
  UCS: { degree: 'BTECH', branch: 'CSE' },
  UCA: { degree: 'BTECH', branch: 'CSAI' },
  UCD: { degree: 'BTECH', branch: 'CSDS' },
  UCM: { degree: 'BTECH', branch: 'MAC' },
  UCI: { degree: 'BTECH', branch: 'CSE_EAST' },
  UCB: { degree: 'BTECH', branch: 'CSAI_EAST' },
  UIT: { degree: 'BTECH', branch: 'IT' },
  UIN: { degree: 'BTECH', branch: 'ITNS' },
  UGI: { degree: 'BTECH', branch: 'GEO' },
  UCG: { degree: 'BTECH', branch: 'GEO' },
  UEC: { degree: 'BTECH', branch: 'ECE' },
  UEA: { degree: 'BTECH', branch: 'ECE_EAST' },
  UEV: { degree: 'BTECH', branch: 'ECVL' },
  UEI: { degree: 'BTECH', branch: 'ECAI' },
  UEE: { degree: 'BTECH', branch: 'EE' },
  UIC: { degree: 'BTECH', branch: 'ICE' },
  UME: { degree: 'BTECH', branch: 'ME' },
  UMP: { degree: 'BTECH', branch: 'MPAE' },
  UMV: { degree: 'BTECH', branch: 'MEEV' },
  UCE: { degree: 'BTECH', branch: 'CIVIL' },
  UBT: { degree: 'BTECH', branch: 'BT' },

  // Lateral B.Tech
  LCE: { degree: 'BTECH_LATERAL', branch: 'CIVIL' },
  LGI: { degree: 'BTECH_LATERAL', branch: 'GEO' },
  LMV: { degree: 'BTECH_LATERAL', branch: 'MEEV' },

  // Design & Architecture
  UBD: { degree: 'BDES', branch: 'BDES' },
  UPD: { degree: 'BDES', branch: 'BDES_PD' },
  UFT: { degree: 'BDES', branch: 'BDES_FT' },
  UAR: { degree: 'BARCH', branch: 'BARCH' },

  // Management
  UBA: { degree: 'BBA_HONS', branch: 'BBA_HONS' },
  IMI: { degree: 'IBBA_MBA_IEV', branch: 'IEVD' },
  PBA: { degree: 'MBA', branch: 'MBA' },
  PMI: { degree: 'MBA', branch: 'MBA' },

  // Masters
  PCS: { degree: 'MTECH', branch: 'CSE' },
  PAI: { degree: 'MTECH', branch: 'CSAI_EAST' },
  PIS: { degree: 'MTECH', branch: 'CSAI_EAST' },
  PSC: { degree: 'MTECH', branch: 'CSE_EAST' },
  PEV: { degree: 'MTECH', branch: 'ECVL' },
  PVL: { degree: 'MTECH', branch: 'ECE_EAST' },
  PIT: { degree: 'MTECH', branch: 'IT' },
  PMN: { degree: 'MTECH', branch: 'IT' },
  PEE: { degree: 'MTECH', branch: 'EE' },
  PME: { degree: 'MTECH', branch: 'ME' },
  PBI: { degree: 'MTECH', branch: 'BT' },
  PSE: { degree: 'MTECH', branch: 'CIVIL' },

  // M.Sc & M.A
  PPH: { degree: 'MSC', branch: 'PHY' },
  PMA: { degree: 'MSC', branch: 'MATH' },
  PCH: { degree: 'MSC', branch: 'CHEM' },
  PAP: { degree: 'MA', branch: 'PSYCH' },
  PEG: { degree: 'MA', branch: 'ENGLISH' },
  PEL: { degree: 'MA', branch: 'ENGLISH' },

  // Ph.D
  RBS: { degree: 'PHD', branch: 'BT' },
  RCE: { degree: 'PHD', branch: 'CIVIL' },
  RCH: { degree: 'PHD', branch: 'CHEM' },
  RCP: { degree: 'PHD', branch: 'CSE_EAST' },
  RCS: { degree: 'PHD', branch: 'CSE' },
  RDG: { degree: 'PHD', branch: 'DESIGN' },
  REC: { degree: 'PHD', branch: 'ECE' },
  REE: { degree: 'PHD', branch: 'EE' },
  REP: { degree: 'PHD', branch: 'ECE_EAST' },
  RHS: { degree: 'PHD', branch: 'HSS' },
  RIV: { degree: 'PHD', branch: 'IEVD' },
  RMA: { degree: 'PHD', branch: 'MATH' },
  RMG: { degree: 'PHD', branch: 'MS' },
  RMW: { degree: 'PHD', branch: 'ME_WEST' },
  RPH: { degree: 'PHD', branch: 'PHY' },
};

export interface BackfillReport {
  unmapped: { field: string; value: string; users: number }[];
  deptUpdated: number;
  designationUpdated: number;
  programUpdated: number;
}

/** Idempotent: upserts the master rows. Safe to run on every startup. */
export async function seedMasterData(c: PoolClient) {
  for (const d of DEPARTMENTS) {
    await c.query(
      `INSERT INTO departments (code,name) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING`,
      [d.code, d.name],
    );
  }
  for (const d of DEGREES) {
    await c.query(
      `INSERT INTO degrees (code,name,duration_years) VALUES ($1,$2,$3) ON CONFLICT (code) DO NOTHING`,
      [d.code, d.name, d.years],
    );
  }
  for (const b of BRANCHES) {
    await c.query(
      `INSERT INTO branches (code,dept_code,name) VALUES ($1,$2,$3) ON CONFLICT (code) DO NOTHING`,
      [b.code, b.dept, b.name],
    );
  }
  for (const [degree, branches] of Object.entries(PROGRAMS)) {
    for (const branch of branches) {
      await c.query(
        `INSERT INTO programs (degree_code,branch_code) VALUES ($1,$2) ON CONFLICT (degree_code,branch_code) DO NOTHING`,
        [degree, branch],
      );
    }
  }
  for (const d of DESIGNATIONS) {
    await c.query(
      `INSERT INTO designations (code,name,category,rank) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO NOTHING`,
      [d.code, d.name, d.category, d.rank],
    );
  }
  for (const t of TERMS) {
    await c.query(
      `INSERT INTO academic_terms (code,name,start_date,end_date,is_current)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (code) DO UPDATE SET
         name = EXCLUDED.name,
         start_date = EXCLUDED.start_date,
         end_date = EXCLUDED.end_date,
         is_current = EXCLUDED.is_current`,
      [t.code, t.name, t.startDate, t.endDate, t.isCurrent],
    );
  }
}

/**
 * Fills dept_code / designation_code from legacy text columns, and sets
 * program_id using roll number patterns and unambiguous degree/dept matching.
 */
export async function backfillUserReferences(c: PoolClient): Promise<BackfillReport> {
  const report: BackfillReport = { unmapped: [], deptUpdated: 0, designationUpdated: 0, programUpdated: 0 };

  // 1. Dept backfill
  const depts = await c.query<{ dept: string; n: string }>(
    `SELECT dept, count(*) n FROM users WHERE dept IS NOT NULL AND dept_code IS NULL GROUP BY dept`,
  );
  for (const r of depts.rows) {
    const code = DEPT_ALIASES[norm(r.dept)];
    if (!code) {
      report.unmapped.push({ field: 'dept', value: r.dept, users: Number(r.n) });
      continue;
    }
    const u = await c.query(`UPDATE users SET dept_code=$1 WHERE dept=$2 AND dept_code IS NULL`, [code, r.dept]);
    report.deptUpdated += u.rowCount ?? 0;
  }

  // 2. Designation backfill
  const desigs = await c.query<{ designation: string; n: string }>(
    `SELECT designation, count(*) n FROM users WHERE designation IS NOT NULL AND designation_code IS NULL GROUP BY designation`,
  );
  for (const r of desigs.rows) {
    const code = DESIGNATION_ALIASES[r.designation.trim()];
    if (!code) {
      report.unmapped.push({ field: 'designation', value: r.designation, users: Number(r.n) });
      continue;
    }
    const u = await c.query(
      `UPDATE users SET designation_code=$1 WHERE designation=$2 AND designation_code IS NULL`,
      [code, r.designation],
    );
    report.designationUpdated += u.rowCount ?? 0;
  }

  // 3. Program backfill from roll_no code mapping
  const rollGroups = await c.query<{ code: string; n: string }>(
    `SELECT substring(roll_no from '[A-Za-z]+') as code, count(*) n
     FROM users
     WHERE roll_no IS NOT NULL AND program_id IS NULL
     GROUP BY 1`,
  );
  for (const r of rollGroups.rows) {
    const target = ROLL_CODE_MAP[r.code];
    if (target) {
      const u = await c.query(
        `UPDATE users u
         SET program_id = p.id
         FROM programs p
         WHERE substring(u.roll_no from '[A-Za-z]+') = $1
           AND u.program_id IS NULL
           AND p.degree_code = $2
           AND p.branch_code = $3`,
        [r.code, target.degree, target.branch],
      );
      report.programUpdated += u.rowCount ?? 0;
    } else {
      report.unmapped.push({ field: 'roll_code', value: r.code, users: Number(r.n) });
    }
  }

  // 4. Fallback for any remaining without roll_no: unambiguous (dept, degree) matching
  const degs = await c.query<{ degree: string; n: string }>(
    `SELECT degree, count(*) n FROM users WHERE degree IS NOT NULL AND program_id IS NULL GROUP BY degree`,
  );
  for (const r of degs.rows) {
    const code = DEGREE_ALIASES[r.degree];
    if (!code) continue;
    const u = await c.query(
      `UPDATE users u SET program_id = p.id
         FROM (
           SELECT b.dept_code, pr.degree_code, min(pr.id) AS id
             FROM programs pr JOIN branches b ON b.code = pr.branch_code
            WHERE pr.status = 'ACTIVE' AND b.status = 'ACTIVE'
            GROUP BY b.dept_code, pr.degree_code
           HAVING count(*) = 1
         ) p
        WHERE u.degree = $1 AND u.program_id IS NULL
          AND p.degree_code = $2 AND p.dept_code = u.dept_code`,
      [r.degree, code],
    );
    report.programUpdated += u.rowCount ?? 0;
  }

  return report;
}
