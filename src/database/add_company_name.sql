-- Add company_name to existing mail_accounts table
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS company_name VARCHAR(255);

-- Create index for company grouping
CREATE INDEX IF NOT EXISTS idx_mail_accounts_company_name ON mail_accounts(company_name);
