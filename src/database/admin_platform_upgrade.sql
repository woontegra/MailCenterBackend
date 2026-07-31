-- Platform admin panel extensions (SUPER_ADMIN / users.role = super_admin)

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_test_account BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP NULL;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS admin_notes TEXT NULL;

ALTER TABLE platform_audit_logs ADD COLUMN IF NOT EXISTS ip_address VARCHAR(64);
ALTER TABLE platform_audit_logs ADD COLUMN IF NOT EXISTS user_agent TEXT;
ALTER TABLE platform_audit_logs ADD COLUMN IF NOT EXISTS metadata JSONB;

CREATE INDEX IF NOT EXISTS idx_tenants_is_test_account ON tenants(is_test_account) WHERE is_test_account = true;
CREATE INDEX IF NOT EXISTS idx_tenants_expires_at ON tenants(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_platform_audit_created ON platform_audit_logs(created_at DESC);
