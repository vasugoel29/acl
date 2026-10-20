-- 003_consolidate_rbac.sql
-- Consolidate classical 5-table RBAC into a modern PostgreSQL 2-table model.
-- app_roles now stores native `permissions TEXT[]`.
-- applications now stores `permissions_catalog JSONB` for human descriptions.

-- 1. Add array column to app_roles
ALTER TABLE app_roles ADD COLUMN IF NOT EXISTS permissions TEXT[] NOT NULL DEFAULT '{}';

-- 2. Add catalog column to applications
ALTER TABLE applications ADD COLUMN IF NOT EXISTS permissions_catalog JSONB NOT NULL DEFAULT '{}';

-- 3. Backfill permissions array from existing role_permissions junction table
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'role_permissions') THEN
    UPDATE app_roles ar
    SET permissions = COALESCE(
      (
        SELECT array_agg(rp.permission ORDER BY rp.permission)
        FROM role_permissions rp
        WHERE rp.app_id = ar.app_id AND rp.role = ar.role
      ),
      '{}'
    );
  END IF;
END $$;

-- 4. Backfill applications.permissions_catalog from app_permissions table
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'app_permissions') THEN
    UPDATE applications a
    SET permissions_catalog = COALESCE(
      (
        SELECT jsonb_object_agg(ap.permission, COALESCE(ap.description, ''))
        FROM app_permissions ap
        WHERE ap.app_id = a.id
      ),
      '{}'
    );
  END IF;
END $$;

-- 5. Drop legacy junction table and unused override table
DROP TABLE IF EXISTS role_permissions CASCADE;
DROP TABLE IF EXISTS user_permission_overrides CASCADE;
