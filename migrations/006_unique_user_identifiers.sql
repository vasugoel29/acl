-- 006_unique_user_identifiers.sql
-- Enforce strict uniqueness across users for email (already CITEXT UNIQUE),
-- roll_no (case-insensitive), twelve_digit_roll_no, and employee_id (case-insensitive).

-- 1. Normalize empty string identifiers to NULL
UPDATE users SET roll_no = NULL WHERE roll_no IS NOT NULL AND btrim(roll_no) = '';
UPDATE users SET employee_id = NULL WHERE employee_id IS NOT NULL AND btrim(employee_id) = '';

-- 2. Deduplicate any legacy case-insensitive roll_no collisions before normalizing to UPPER
WITH ranked_roll AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY UPPER(btrim(roll_no))
           ORDER BY (status = 'ACTIVE') DESC, updated_at DESC, created_at DESC, id DESC
         ) AS rn
  FROM users
  WHERE roll_no IS NOT NULL
)
UPDATE users u
SET roll_no = NULL
FROM ranked_roll r
WHERE u.id = r.id AND r.rn > 1;

UPDATE users
SET roll_no = UPPER(btrim(roll_no))
WHERE roll_no IS NOT NULL AND roll_no != UPPER(btrim(roll_no));

-- 3. Deduplicate any legacy twelve_digit_roll_no collisions before adding unique index
WITH ranked_12 AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY twelve_digit_roll_no
           ORDER BY (status = 'ACTIVE') DESC, updated_at DESC, created_at DESC, id DESC
         ) AS rn
  FROM users
  WHERE twelve_digit_roll_no IS NOT NULL
)
UPDATE users u
SET twelve_digit_roll_no = NULL
FROM ranked_12 r
WHERE u.id = r.id AND r.rn > 1;

-- 4. Deduplicate any legacy case-insensitive employee_id collisions
WITH ranked_emp AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY UPPER(btrim(employee_id))
           ORDER BY (status = 'ACTIVE') DESC, updated_at DESC, created_at DESC, id DESC
         ) AS rn
  FROM users
  WHERE employee_id IS NOT NULL
)
UPDATE users u
SET employee_id = NULL
FROM ranked_emp r
WHERE u.id = r.id AND r.rn > 1;

-- 5. Add unique partial indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_roll_no_upper_uniq
  ON users (UPPER(roll_no))
  WHERE roll_no IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_twelve_digit_roll_no_uniq
  ON users (twelve_digit_roll_no)
  WHERE twelve_digit_roll_no IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_employee_id_upper_uniq
  ON users (UPPER(employee_id))
  WHERE employee_id IS NOT NULL;
