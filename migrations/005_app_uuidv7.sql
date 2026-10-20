-- 005_app_uuidv7.sql
-- Transition applications.id from plaintext strings (ACL, CRAS) to prefixed UUIDv7/ULIDs (app_...)
-- Preserves client_id column with unique constraint for backward-compatible OIDC integrations.

-- 1. Add client_id column to applications
ALTER TABLE applications ADD COLUMN IF NOT EXISTS client_id TEXT;
UPDATE applications SET client_id = id WHERE client_id IS NULL;
ALTER TABLE applications ALTER COLUMN client_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_client_id ON applications (client_id);

-- 2. Helper mapping function for deterministic migration
CREATE OR REPLACE FUNCTION map_legacy_app_id(old_id TEXT) RETURNS TEXT AS $$
BEGIN
  CASE old_id
    WHEN 'ACL' THEN RETURN 'app_01JACL00000000000000000000';
    WHEN 'CRAS' THEN RETURN 'app_01JCRAS0000000000000000000';
    WHEN 'HAJIRI' THEN RETURN 'app_01JHAJIRI00000000000000000';
    WHEN 'CAMPUS_FLOW' THEN RETURN 'app_01JCAMPUS0000000000000000';
    WHEN 'REC_PORTAL' THEN RETURN 'app_01JREC0000000000000000000';
    ELSE
      IF old_id LIKE 'app_%' THEN RETURN old_id;
      ELSE RETURN 'app_' || substr(md5(old_id), 1, 26);
      END IF;
  END CASE;
END;
$$ LANGUAGE plpgsql;

-- 3. Drop existing foreign key constraints on app_id
ALTER TABLE app_roles DROP CONSTRAINT IF EXISTS app_roles_app_id_fkey;
ALTER TABLE app_resources DROP CONSTRAINT IF EXISTS app_permissions_app_id_fkey;
ALTER TABLE app_resources DROP CONSTRAINT IF EXISTS app_resources_app_id_fkey;
ALTER TABLE user_app_roles DROP CONSTRAINT IF EXISTS user_app_roles_app_id_role_fkey;
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_app_id_fkey;

-- 4. Update child tables to new app_ IDs
UPDATE app_roles SET app_id = map_legacy_app_id(app_id) WHERE app_id NOT LIKE 'app_%';
UPDATE app_resources SET app_id = map_legacy_app_id(app_id) WHERE app_id NOT LIKE 'app_%';
UPDATE user_app_roles SET app_id = map_legacy_app_id(app_id) WHERE app_id NOT LIKE 'app_%';
UPDATE sessions SET app_id = map_legacy_app_id(app_id) WHERE app_id NOT LIKE 'app_%';
UPDATE auth_codes SET app_id = map_legacy_app_id(app_id) WHERE app_id NOT LIKE 'app_%';

-- 5. Update applications primary key
UPDATE applications SET id = map_legacy_app_id(id) WHERE id NOT LIKE 'app_%';

-- 6. Clean up mapping helper
DROP FUNCTION map_legacy_app_id(TEXT);

-- 7. Re-add foreign key constraints with ON UPDATE CASCADE ON DELETE CASCADE
ALTER TABLE app_roles
  ADD CONSTRAINT app_roles_app_id_fkey
  FOREIGN KEY (app_id) REFERENCES applications(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE app_resources
  ADD CONSTRAINT app_resources_app_id_fkey
  FOREIGN KEY (app_id) REFERENCES applications(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE user_app_roles
  ADD CONSTRAINT user_app_roles_app_id_role_fkey
  FOREIGN KEY (app_id, role) REFERENCES app_roles(app_id, role) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_app_id_fkey
  FOREIGN KEY (app_id) REFERENCES applications(id) ON UPDATE CASCADE ON DELETE CASCADE;
