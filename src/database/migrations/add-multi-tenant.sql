-- Create tenants table
CREATE TABLE IF NOT EXISTS tenants (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create users table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add tenant_id to mail_accounts
ALTER TABLE mail_accounts
ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE;

-- Add tenant_id to mails
ALTER TABLE mails
ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE;

-- Add tenant_id to tags
ALTER TABLE tags
ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE;

-- Add tenant_id to mail_tags (not needed as it's a junction table, but for consistency)
ALTER TABLE mail_tags
ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE;

-- Create indexes for tenant_id columns
CREATE INDEX IF NOT EXISTS idx_mail_accounts_tenant_id ON mail_accounts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_mails_tenant_id ON mails(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tags_tenant_id ON tags(tenant_id);
CREATE INDEX IF NOT EXISTS idx_mail_tags_tenant_id ON mail_tags(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Update existing tags to have tenant_id = NULL (will be set when users are created)
-- This allows backward compatibility
