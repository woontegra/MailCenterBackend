-- Add SMTP fields to mail_accounts table
ALTER TABLE mail_accounts 
ADD COLUMN IF NOT EXISTS smtp_host VARCHAR(255),
ADD COLUMN IF NOT EXISTS smtp_port INTEGER DEFAULT 587,
ADD COLUMN IF NOT EXISTS smtp_user VARCHAR(255),
ADD COLUMN IF NOT EXISTS smtp_password TEXT,
ADD COLUMN IF NOT EXISTS smtp_secure BOOLEAN DEFAULT false;

-- Add is_sent field to mails table
ALTER TABLE mails
ADD COLUMN IF NOT EXISTS is_sent BOOLEAN DEFAULT false;

-- Add index for sent mails
CREATE INDEX IF NOT EXISTS idx_mails_is_sent ON mails(is_sent);
