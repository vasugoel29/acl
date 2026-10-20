-- Master reference data. Stable human-readable codes are the primary keys;
-- `users` references them via foreign keys. Old text columns (dept, branch,
-- degree, designation) are intentionally kept for one release as a safety net.

CREATE TABLE IF NOT EXISTS departments (
  code       TEXT PRIMARY KEY CHECK (code ~ '^[A-Z0-9_]+$'),
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS degrees (
  code           TEXT PRIMARY KEY CHECK (code ~ '^[A-Z0-9_]+$'),
  name           TEXT NOT NULL,
  duration_years INT CHECK (duration_years > 0),
  status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS branches (
  code       TEXT PRIMARY KEY CHECK (code ~ '^[A-Z0-9_]+$'),
  dept_code  TEXT NOT NULL REFERENCES departments(code) ON UPDATE CASCADE,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_branches_dept ON branches (dept_code);

-- A program is a valid degree + branch pair; students enroll in a program.
CREATE TABLE IF NOT EXISTS programs (
  id          SERIAL PRIMARY KEY,
  degree_code TEXT NOT NULL REFERENCES degrees(code) ON UPDATE CASCADE,
  branch_code TEXT NOT NULL REFERENCES branches(code) ON UPDATE CASCADE,
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (degree_code, branch_code)
);

CREATE TABLE IF NOT EXISTS academic_terms (
  code       TEXT PRIMARY KEY CHECK (code ~ '^[A-Z0-9_-]+$'),  -- e.g. 2026-ODD
  name       TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date   DATE NOT NULL,
  is_current BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date > start_date)
);
-- At most one current term.
CREATE UNIQUE INDEX IF NOT EXISTS academic_terms_one_current
  ON academic_terms (is_current) WHERE is_current;

CREATE TABLE IF NOT EXISTS designations (
  code       TEXT PRIMARY KEY CHECK (code ~ '^[A-Z0-9_]+$'),
  name       TEXT NOT NULL,
  category   TEXT NOT NULL CHECK (category IN ('FACULTY','STAFF')),
  rank       INT NOT NULL DEFAULT 100,
  status     TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- User references (nullable until backfilled; strictness is enforced in the API).
ALTER TABLE users ADD COLUMN IF NOT EXISTS dept_code        TEXT REFERENCES departments(code) ON UPDATE CASCADE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS program_id       INT  REFERENCES programs(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS designation_code TEXT REFERENCES designations(code) ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS idx_users_dept_code        ON users (dept_code);
CREATE INDEX IF NOT EXISTS idx_users_program_id       ON users (program_id);
CREATE INDEX IF NOT EXISTS idx_users_designation_code ON users (designation_code);
