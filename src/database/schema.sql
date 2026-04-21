-- Tenants Table
CREATE TABLE IF NOT EXISTS tenants (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Users Table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Mail Accounts Table
CREATE TABLE IF NOT EXISTS mail_accounts (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  imap_host VARCHAR(255) NOT NULL,
  imap_port INTEGER NOT NULL DEFAULT 993,
  imap_user VARCHAR(255) NOT NULL,
  imap_password TEXT NOT NULL,
  smtp_host VARCHAR(255),
  smtp_port INTEGER DEFAULT 587,
  smtp_user VARCHAR(255),
  smtp_password TEXT,
  smtp_secure BOOLEAN DEFAULT false,
  company_name VARCHAR(255),
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Mails Table
CREATE TABLE IF NOT EXISTS mails (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  message_id VARCHAR(500) UNIQUE,
  subject TEXT,
  from_address VARCHAR(500),
  to_address TEXT,
  date TIMESTAMP,
  body_preview TEXT,
  is_read BOOLEAN DEFAULT false,
  is_starred BOOLEAN DEFAULT false,
  is_deleted BOOLEAN DEFAULT false,
  is_sent BOOLEAN DEFAULT false,
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  raw_headers JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tags Table
CREATE TABLE IF NOT EXISTS tags (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  color VARCHAR(7) DEFAULT '#6B7280',
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(name, tenant_id)
);

-- Mail-Tags Relationship Table
CREATE TABLE IF NOT EXISTS mail_tags (
  id SERIAL PRIMARY KEY,
  mail_id INTEGER NOT NULL REFERENCES mails(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(mail_id, tag_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_mail_accounts_tenant_id ON mail_accounts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_mails_tenant_id ON mails(tenant_id);
CREATE INDEX IF NOT EXISTS idx_mails_account_id ON mails(account_id);
CREATE INDEX IF NOT EXISTS idx_mails_date ON mails(date DESC);
CREATE INDEX IF NOT EXISTS idx_mails_is_read ON mails(is_read);
CREATE INDEX IF NOT EXISTS idx_mails_is_starred ON mails(is_starred);
CREATE INDEX IF NOT EXISTS idx_mails_is_deleted ON mails(is_deleted);
CREATE INDEX IF NOT EXISTS idx_mails_is_sent ON mails(is_sent);
CREATE INDEX IF NOT EXISTS idx_tags_tenant_id ON tags(tenant_id);
CREATE INDEX IF NOT EXISTS idx_mail_tags_mail_id ON mail_tags(mail_id);
CREATE INDEX IF NOT EXISTS idx_mail_tags_tag_id ON mail_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_mail_tags_tenant_id ON mail_tags(tenant_id);

-- Default tags will be created per tenant during registration
