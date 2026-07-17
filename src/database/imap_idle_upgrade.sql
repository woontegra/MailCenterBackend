-- IMAP IDLE / reconciliation fields (idempotent)
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS imap_uidvalidity BIGINT;
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMP;
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS imap_idle_status VARCHAR(20) DEFAULT 'DISABLED';
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS imap_idle_error TEXT;
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS imap_connected_at TIMESTAMP;
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS imap_listener_active BOOLEAN DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mail_accounts_imap_idle_status_check'
  ) THEN
    ALTER TABLE mail_accounts
      ADD CONSTRAINT mail_accounts_imap_idle_status_check
      CHECK (
        imap_idle_status IS NULL OR imap_idle_status IN (
          'CONNECTING', 'IDLE', 'RECONNECTING', 'ERROR', 'DISABLED'
        )
      );
  END IF;
END $$;

ALTER TABLE mails ADD COLUMN IF NOT EXISTS imap_uid BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mails_account_imap_uid
  ON mails(account_id, imap_uid)
  WHERE imap_uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mail_accounts_idle_active
  ON mail_accounts(is_active, imap_listener_active)
  WHERE is_active = true;
