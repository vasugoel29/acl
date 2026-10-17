-- NSUT Identity & ACL Service — Consolidated Canonical Database Schema
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1. Core Unified Users Directory (Students, Faculty, Staff, Admins)
CREATE TABLE IF NOT EXISTS users (
  id                   TEXT PRIMARY KEY,
  email                CITEXT UNIQUE NOT NULL,
  google_sub           TEXT UNIQUE,
  name                 TEXT NOT NULL,
  avatar_url           TEXT,
  status               TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','ARCHIVED')),
  roll_no              TEXT UNIQUE,
  twelve_digit_roll_no BIGINT,
  dept                 TEXT,
  branch               TEXT,
  degree               TEXT,
  year                 INT,
  semester             INT,
  section              INT,
  group_no             INT,
  batch_no             INT,
  batch_year           INT,
  employee_id          TEXT UNIQUE,
  designation          TEXT,
  mobile_no            TEXT,
  acl_version          INT NOT NULL DEFAULT 1,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_roll_no ON users (roll_no);
CREATE INDEX IF NOT EXISTS idx_users_twelve_digit_roll_no ON users (twelve_digit_roll_no);
CREATE INDEX IF NOT EXISTS idx_users_dept_branch ON users (dept, branch);
CREATE INDEX IF NOT EXISTS idx_users_academic ON users (year, semester, section, group_no, batch_no);
CREATE INDEX IF NOT EXISTS idx_users_employee_id ON users (employee_id);
CREATE INDEX IF NOT EXISTS idx_users_mobile_no ON users (mobile_no);
CREATE INDEX IF NOT EXISTS idx_users_email_trgm ON users USING gin ((email::text) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_name_trgm ON users USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_roll_no_trgm ON users USING gin (roll_no gin_trgm_ops);

-- 2. Registered OIDC Client Applications & RBAC/ABAC Catalog
CREATE TABLE IF NOT EXISTS applications (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  client_secret_hash TEXT,
  redirect_uris      TEXT[] NOT NULL,
  status             TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_permissions (
  app_id      TEXT REFERENCES applications(id) ON DELETE CASCADE,
  permission  TEXT NOT NULL,
  description TEXT,
  PRIMARY KEY (app_id, permission)
);

CREATE TABLE IF NOT EXISTS app_roles (
  app_id        TEXT REFERENCES applications(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,
  description   TEXT,
  is_default    BOOLEAN NOT NULL DEFAULT false,
  -- scope key -> academic field, e.g. {"roll_no":"roll_no"}; used when role is applied implicitly
  default_scope JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (app_id, role)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  app_id     TEXT,
  role       TEXT,
  permission TEXT,
  PRIMARY KEY (app_id, role, permission),
  FOREIGN KEY (app_id, role)       REFERENCES app_roles(app_id, role) ON DELETE CASCADE,
  FOREIGN KEY (app_id, permission) REFERENCES app_permissions(app_id, permission) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_app_roles (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id     TEXT NOT NULL,
  role       TEXT NOT NULL,
  scope      JSONB NOT NULL DEFAULT '{}',
  granted_by TEXT REFERENCES users(id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  CONSTRAINT user_app_roles_app_id_role_fkey FOREIGN KEY (app_id, role) REFERENCES app_roles(app_id, role) ON DELETE CASCADE,
  UNIQUE (user_id, app_id, role, scope)
);

CREATE INDEX IF NOT EXISTS user_app_roles_user_app_idx ON user_app_roles (user_id, app_id);

CREATE TABLE IF NOT EXISTS user_permission_overrides (
  user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  app_id     TEXT,
  permission TEXT,
  effect     TEXT CHECK (effect IN ('ALLOW','DENY')),
  PRIMARY KEY (user_id, app_id, permission)
);

-- 3. OIDC Authorization Codes & Refresh Token Sessions
CREATE TABLE IF NOT EXISTS auth_codes (
  code_hash      TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id         TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  nonce          TEXT,
  expires_at     TIMESTAMPTZ NOT NULL,
  used_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_auth_codes_expires_at ON auth_codes (expires_at);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
  app_id       TEXT,
  refresh_hash TEXT NOT NULL,
  family_id    TEXT NOT NULL,
  user_agent   TEXT,
  ip           INET,
  created_at   TIMESTAMPTZ DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sessions_refresh_hash_idx ON sessions (refresh_hash);
CREATE INDEX IF NOT EXISTS sessions_family_idx ON sessions (family_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);

-- 4. Immutable Append-Only Security Audit Log
CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  app_id      TEXT,
  metadata    JSONB,
  ip          INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_target_idx ON audit_logs (target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at DESC);

CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs;
CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

DROP TRIGGER IF EXISTS audit_logs_no_truncate ON audit_logs;
CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON audit_logs
  EXECUTE FUNCTION audit_logs_immutable();

-- 5. Persistent Job Tracking (CSV Import, Export, Semester Rollover)
CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL, -- 'IMPORT', 'EXPORT', 'ROLLOVER'
  status         TEXT NOT NULL DEFAULT 'QUEUED', -- 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED'
  actor_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_email    TEXT,
  filename       TEXT,
  total_rows     INT DEFAULT 0,
  processed_rows INT DEFAULT 0,
  created_count  INT DEFAULT 0,
  updated_count  INT DEFAULT 0,
  failed_count   INT DEFAULT 0,
  progress_pct   INT DEFAULT 0,
  error_message  TEXT,
  metadata       JSONB DEFAULT '{}'::jsonb,
  started_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_created_at ON ingestion_jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_status ON ingestion_jobs (status);

-- 6. Persistent ES256 JWK Keyset Storage (Serverless / Multi-Replica)
CREATE TABLE IF NOT EXISTS signing_keys (
  id         TEXT PRIMARY KEY,
  keys_json  JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
