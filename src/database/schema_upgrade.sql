-- MailCenter SaaS Upgrade Schema
-- Run this after the base schema.sql

-- 1. EXTEND USERS TABLE
ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'member' CHECK (role IN ('admin', 'member'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{}';

-- 2. EXTEND TENANTS TABLE
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(50) DEFAULT 'free';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

-- 3. MAIL THREADING (CONVERSATIONS)
CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  subject TEXT NOT NULL,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_message_at TIMESTAMP
);

ALTER TABLE mails ADD COLUMN IF NOT EXISTS conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE mails ADD COLUMN IF NOT EXISTS in_reply_to VARCHAR(500);
ALTER TABLE mails ADD COLUMN IF NOT EXISTS references TEXT;

-- 4. MAIL STATUS & ASSIGNMENT
ALTER TABLE mails ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'pending', 'closed'));
ALTER TABLE mails ADD COLUMN IF NOT EXISTS assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE mails ADD COLUMN IF NOT EXISTS priority VARCHAR(20) DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent'));

-- 5. ATTACHMENTS
CREATE TABLE IF NOT EXISTS attachments (
  id SERIAL PRIMARY KEY,
  mail_id INTEGER NOT NULL REFERENCES mails(id) ON DELETE CASCADE,
  filename VARCHAR(255) NOT NULL,
  content_type VARCHAR(100),
  size_bytes INTEGER,
  storage_path TEXT NOT NULL,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 6. AUTOMATION RULES
CREATE TABLE IF NOT EXISTS automation_rules (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  is_active BOOLEAN DEFAULT true,
  conditions JSONB NOT NULL,
  actions JSONB NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. NOTIFICATIONS
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  message TEXT,
  data JSONB,
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 8. USER INVITES
CREATE TABLE IF NOT EXISTS invites (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  role VARCHAR(20) DEFAULT 'member',
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  accepted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 9. DRAFTS
CREATE TABLE IF NOT EXISTS drafts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id INTEGER REFERENCES mail_accounts(id) ON DELETE CASCADE,
  to_address TEXT,
  cc_address TEXT,
  bcc_address TEXT,
  subject TEXT,
  body TEXT,
  attachments JSONB DEFAULT '[]',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 10. QUICK REPLY TEMPLATES
CREATE TABLE IF NOT EXISTS templates (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_shared BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 11. ACTIVITY LOG
CREATE TABLE IF NOT EXISTS activity_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50),
  entity_id INTEGER,
  metadata JSONB,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 12. SAVED SEARCHES
CREATE TABLE IF NOT EXISTS saved_searches (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  query JSONB NOT NULL,
  is_shared BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- INDEXES FOR NEW TABLES
CREATE INDEX IF NOT EXISTS idx_conversations_tenant_id ON conversations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_mails_conversation_id ON mails(conversation_id);
CREATE INDEX IF NOT EXISTS idx_mails_status ON mails(status);
CREATE INDEX IF NOT EXISTS idx_mails_assigned_to ON mails(assigned_to);
CREATE INDEX IF NOT EXISTS idx_mails_priority ON mails(priority);
CREATE INDEX IF NOT EXISTS idx_attachments_mail_id ON attachments(mail_id);
CREATE INDEX IF NOT EXISTS idx_attachments_tenant_id ON attachments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_automation_rules_tenant_id ON automation_rules(tenant_id);
CREATE INDEX IF NOT EXISTS idx_automation_rules_is_active ON automation_rules(is_active);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invites_tenant_id ON invites(tenant_id);
CREATE INDEX IF NOT EXISTS idx_invites_token ON invites(token);
CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email);
CREATE INDEX IF NOT EXISTS idx_drafts_user_id ON drafts(user_id);
CREATE INDEX IF NOT EXISTS idx_drafts_tenant_id ON drafts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_templates_tenant_id ON templates(tenant_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_tenant_id ON activity_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id ON activity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_searches_user_id ON saved_searches(user_id);
CREATE INDEX IF NOT EXISTS idx_saved_searches_tenant_id ON saved_searches(tenant_id);

-- FULL TEXT SEARCH
CREATE INDEX IF NOT EXISTS idx_mails_subject_fulltext ON mails USING gin(to_tsvector('english', subject));
CREATE INDEX IF NOT EXISTS idx_mails_body_fulltext ON mails USING gin(to_tsvector('english', body_preview));
