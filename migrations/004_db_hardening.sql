-- 004_db_hardening.sql
-- 1. Rename app_permissions table to app_resources
-- 2. Align branch IEVD under department MS (Management Studies) to resolve department mismatches
-- 3. Add GIN index on user_app_roles.scope for fast ABAC queries
-- 4. Auto-sync year from semester via database trigger
-- 5. Create canonical v_users_directory view

-- 1. Rename app_permissions table to app_resources
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'app_permissions') THEN
    ALTER TABLE app_permissions RENAME TO app_resources;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS app_resources (
  app_id      TEXT REFERENCES applications(id) ON DELETE CASCADE,
  permission  TEXT NOT NULL,
  description TEXT,
  PRIMARY KEY (app_id, permission)
);

-- 2. Align branch IEVD under department MS (Management Studies)
UPDATE branches SET dept_code = 'MS' WHERE code = 'IEVD';
UPDATE users SET dept_code = 'MS' WHERE dept_code = 'IEVD';
DELETE FROM departments WHERE code = 'IEVD';

-- 3. GIN index on user_app_roles.scope
CREATE INDEX IF NOT EXISTS idx_user_app_roles_scope ON user_app_roles USING gin (scope);

-- 4. Trigger to auto-sync year from semester
CREATE OR REPLACE FUNCTION sync_user_year()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.semester IS NOT NULL THEN
    NEW.year := ceil(NEW.semester::float / 2);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_user_year ON users;
CREATE TRIGGER trg_sync_user_year
  BEFORE INSERT OR UPDATE OF semester ON users
  FOR EACH ROW
  EXECUTE FUNCTION sync_user_year();

-- Sync existing rows where semester is set but year is null or out of sync
UPDATE users
SET year = ceil(semester::float / 2)
WHERE semester IS NOT NULL AND (year IS NULL OR year != ceil(semester::float / 2));

-- 5. Canonical view v_users_directory
CREATE OR REPLACE VIEW v_users_directory AS
SELECT u.id,
       u.email,
       u.name,
       u.status,
       u.avatar_url,
       u.roll_no,
       u.twelve_digit_roll_no,
       u.dept_code,
       d.name AS dept_name,
       u.program_id,
       deg.code AS degree_code,
       deg.name AS degree_name,
       b.code AS branch_code,
       b.name AS branch_name,
       u.year,
       u.semester,
       u.section,
       u.group_no,
       u.batch_no,
       u.batch_year,
       u.employee_id,
       u.designation_code,
       des.name AS designation_name,
       u.mobile_no,
       u.acl_version,
       u.created_at,
       u.updated_at
FROM users u
LEFT JOIN departments d ON d.code = u.dept_code
LEFT JOIN programs p ON p.id = u.program_id
LEFT JOIN branches b ON b.code = p.branch_code
LEFT JOIN degrees deg ON deg.code = p.degree_code
LEFT JOIN designations des ON des.code = u.designation_code;
