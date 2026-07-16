-- Team roles & permissions (idempotent, non-destructive)

-- Platform role stays on users.role (user/admin/super_admin)
-- Tenant RBAC uses tenant_role
ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_role VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS permission_version INTEGER NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_tenant_role_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_tenant_role_check
      CHECK (
        tenant_role IS NULL
        OR tenant_role IN ('OWNER', 'ADMIN', 'MANAGER', 'AGENT', 'VIEWER')
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_tenant_role
  ON users(tenant_id, tenant_role);

-- Backfill tenant_role from legacy role (idempotent)
-- First admin (lowest id) per tenant → OWNER; other admins → ADMIN; others → AGENT
WITH ranked AS (
  SELECT
    id,
    tenant_id,
    role,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id
      ORDER BY CASE WHEN LOWER(COALESCE(role, '')) = 'admin' THEN 0 ELSE 1 END, id ASC
    ) AS rn
  FROM users
  WHERE COALESCE(role, '') <> 'super_admin'
    AND tenant_role IS NULL
)
UPDATE users u
SET tenant_role = CASE
  WHEN LOWER(COALESCE(r.role, '')) = 'admin' AND r.rn = 1 THEN 'OWNER'
  WHEN LOWER(COALESCE(r.role, '')) = 'admin' THEN 'ADMIN'
  ELSE 'AGENT'
END
FROM ranked r
WHERE u.id = r.id
  AND u.tenant_role IS NULL;

-- Any remaining non-super_admin without tenant_role
UPDATE users
SET tenant_role = 'AGENT'
WHERE tenant_role IS NULL
  AND COALESCE(role, '') <> 'super_admin';

-- Permission overrides (grant/deny extras on top of role map)
CREATE TABLE IF NOT EXISTS user_permission_overrides (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_key VARCHAR(80) NOT NULL,
  effect VARCHAR(10) NOT NULL CHECK (effect IN ('ALLOW', 'DENY')),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, permission_key)
);

CREATE INDEX IF NOT EXISTS idx_user_permission_overrides_tenant
  ON user_permission_overrides(tenant_id, user_id);

-- Extend invites for secure team invites
ALTER TABLE invites ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'PENDING';
ALTER TABLE invites ADD COLUMN IF NOT EXISTS token_hash VARCHAR(128);
ALTER TABLE invites ADD COLUMN IF NOT EXISTS tenant_role VARCHAR(20);
ALTER TABLE invites ADD COLUMN IF NOT EXISTS permission_overrides JSONB DEFAULT '[]'::jsonb;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMP;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS email_send_status VARCHAR(40);
ALTER TABLE invites ADD COLUMN IF NOT EXISTS email_send_message TEXT;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS outbound_message_id INTEGER REFERENCES outbound_messages(id) ON DELETE SET NULL;

-- Migrate legacy: keep pending invites usable via legacy token until accepted;
-- new invites store only token_hash (plaintext cleared after insert in app).
UPDATE invites
SET status = CASE
  WHEN accepted_at IS NOT NULL THEN 'ACCEPTED'
  WHEN expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP THEN 'EXPIRED'
  ELSE COALESCE(NULLIF(status, ''), 'PENDING')
END
WHERE true;

UPDATE invites
SET tenant_role = CASE
  WHEN UPPER(COALESCE(role, '')) IN ('OWNER', 'ADMIN', 'MANAGER', 'AGENT', 'VIEWER')
    THEN UPPER(role)
  WHEN LOWER(COALESCE(role, '')) = 'admin' THEN 'ADMIN'
  ELSE 'AGENT'
END
WHERE tenant_role IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invites_status_check'
  ) THEN
    ALTER TABLE invites
      ADD CONSTRAINT invites_status_check
      CHECK (status IN ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invites_tenant_role_check'
  ) THEN
    ALTER TABLE invites
      ADD CONSTRAINT invites_tenant_role_check
      CHECK (
        tenant_role IS NULL
        OR tenant_role IN ('OWNER', 'ADMIN', 'MANAGER', 'AGENT', 'VIEWER')
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_invites_tenant_status
  ON invites(tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_invites_token_hash
  ON invites(token_hash)
  WHERE token_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_invites_pending_email_tenant
  ON invites(tenant_id, LOWER(email))
  WHERE status = 'PENDING';
