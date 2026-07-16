-- Brand-linked mail accounts: connection status columns + legacy backfill
-- Idempotent and non-destructive

-- Tenant-scoped email uniqueness: the legacy global UNIQUE(email) blocked
-- different tenants from connecting the same mailbox and leaked its existence.
ALTER TABLE mail_accounts DROP CONSTRAINT IF EXISTS mail_accounts_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_mail_accounts_tenant_email
  ON mail_accounts(tenant_id, email);

ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS imap_secure BOOLEAN DEFAULT true;
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS imap_connection_status VARCHAR(20) DEFAULT 'unknown';
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS smtp_connection_status VARCHAR(20) DEFAULT 'unknown';
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS last_connection_test_at TIMESTAMP;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mail_accounts_imap_connection_status_check'
  ) THEN
    ALTER TABLE mail_accounts
      ADD CONSTRAINT mail_accounts_imap_connection_status_check
      CHECK (imap_connection_status IS NULL OR imap_connection_status IN ('unknown', 'ok', 'error'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mail_accounts_smtp_connection_status_check'
  ) THEN
    ALTER TABLE mail_accounts
      ADD CONSTRAINT mail_accounts_smtp_connection_status_check
      CHECK (smtp_connection_status IS NULL OR smtp_connection_status IN ('unknown', 'ok', 'error'));
  END IF;
END $$;

-- Backfill EMAIL channel_connections for orphan mail accounts (first brand of tenant)
INSERT INTO channel_connections (
  tenant_id,
  brand_id,
  channel_type,
  provider,
  display_name,
  status,
  mail_account_id,
  settings
)
SELECT
  ma.tenant_id,
  b.id,
  'EMAIL',
  COALESCE(NULLIF(ma.provider, ''), 'imap'),
  LEFT(COALESCE(ma.name, ma.email) || ' · E-posta', 255),
  CASE
    WHEN ma.is_active = false THEN 'DISABLED'
    ELSE 'NOT_CONFIGURED'
  END,
  ma.id,
  '{}'::jsonb
FROM mail_accounts ma
INNER JOIN LATERAL (
  SELECT id
  FROM brands
  WHERE tenant_id = ma.tenant_id
  ORDER BY id ASC
  LIMIT 1
) b ON true
WHERE ma.tenant_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM channel_connections cc
    WHERE cc.mail_account_id = ma.id
      AND cc.tenant_id = ma.tenant_id
      AND cc.channel_type = 'EMAIL'
  );

-- Backfill default sender identities for those connections
INSERT INTO sender_identities (
  tenant_id,
  brand_id,
  channel_connection_id,
  channel_type,
  display_name,
  sender_value,
  reply_to,
  is_default,
  is_verified,
  is_active
)
SELECT
  cc.tenant_id,
  cc.brand_id,
  cc.id,
  'EMAIL',
  COALESCE(ma.name, ma.email),
  ma.email,
  NULL,
  true,
  false,
  COALESCE(ma.is_active, true)
FROM channel_connections cc
INNER JOIN mail_accounts ma
  ON ma.id = cc.mail_account_id
 AND ma.tenant_id = cc.tenant_id
WHERE cc.channel_type = 'EMAIL'
  AND cc.mail_account_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM sender_identities si
    WHERE si.channel_connection_id = cc.id
      AND si.tenant_id = cc.tenant_id
  );
