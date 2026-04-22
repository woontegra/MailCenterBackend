-- OAuth and Storage Quota Upgrade

-- 1. EXTEND MAIL_ACCOUNTS FOR OAUTH
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS provider VARCHAR(20) DEFAULT 'imap' CHECK (provider IN ('gmail', 'outlook', 'yahoo', 'imap'));
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS auth_type VARCHAR(20) DEFAULT 'password' CHECK (auth_type IN ('password', 'oauth'));
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS access_token TEXT;
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS refresh_token TEXT;
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMP;

-- 2. EXTEND TENANTS FOR STORAGE QUOTA
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS storage_used_mb BIGINT DEFAULT 0;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS storage_limit_mb BIGINT DEFAULT 500;

-- 3. EXTEND PLANS FOR STORAGE LIMITS
ALTER TABLE plans ADD COLUMN IF NOT EXISTS storage_limit_mb BIGINT DEFAULT 500;

UPDATE plans SET storage_limit_mb = 500 WHERE name = 'starter';
UPDATE plans SET storage_limit_mb = 1024 WHERE name = 'pro';
UPDATE plans SET storage_limit_mb = 999999 WHERE name = 'enterprise';

-- 4. ADD MAIL SIZE TRACKING
ALTER TABLE mails ADD COLUMN IF NOT EXISTS size_bytes BIGINT DEFAULT 0;

-- 5. OAUTH TOKENS TABLE
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  provider VARCHAR(20) NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_type VARCHAR(50) DEFAULT 'Bearer',
  expires_at TIMESTAMP NOT NULL,
  scope TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 6. INDEXES
CREATE INDEX IF NOT EXISTS idx_mail_accounts_provider ON mail_accounts(provider);
CREATE INDEX IF NOT EXISTS idx_mail_accounts_auth_type ON mail_accounts(auth_type);
CREATE INDEX IF NOT EXISTS idx_mail_accounts_token_expires ON mail_accounts(token_expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_account_id ON oauth_tokens(account_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expires_at ON oauth_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_mails_size_bytes ON mails(size_bytes);
CREATE INDEX IF NOT EXISTS idx_tenants_storage_used ON tenants(storage_used_mb);
