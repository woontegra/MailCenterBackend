-- Super Admin System Upgrade (idempotent)
-- Platform role: user | admin | super_admin
-- Legacy role "member" must be normalized before tightening the check constraint,
-- otherwise Railway/prod DBs with existing member rows fail with 23514.

-- 1. Normalize legacy platform roles
UPDATE users
SET role = CASE
  WHEN LOWER(COALESCE(role, '')) IN ('super_admin', 'superadmin') THEN 'super_admin'
  WHEN LOWER(COALESCE(role, '')) = 'admin' THEN 'admin'
  ELSE 'user'
END
WHERE COALESCE(role, '') NOT IN ('user', 'admin', 'super_admin');

ALTER TABLE users ALTER COLUMN role SET DEFAULT 'user';

-- 2. Tighten check constraint (drop + add is safe after normalize)
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin', 'super_admin'));

-- 3. Admin activity logs
CREATE TABLE IF NOT EXISTS admin_activity_logs (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action VARCHAR(100) NOT NULL,
  target_type VARCHAR(50),
  target_id INTEGER,
  details JSONB,
  ip_address VARCHAR(45),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. Indexes
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_admin_activity_logs_admin_id ON admin_activity_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_activity_logs_created_at ON admin_activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_activity_logs_action ON admin_activity_logs(action);
