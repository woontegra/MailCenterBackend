-- Mail Operations System Upgrade

-- Add thread and status fields to mails
ALTER TABLE mails ADD COLUMN IF NOT EXISTS thread_id VARCHAR(255);
ALTER TABLE mails ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'pending', 'closed'));
ALTER TABLE mails ADD COLUMN IF NOT EXISTS assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_mails_thread_id ON mails(thread_id);
CREATE INDEX IF NOT EXISTS idx_mails_status ON mails(status);
CREATE INDEX IF NOT EXISTS idx_mails_assigned_to ON mails(assigned_to);

-- Mail notes table
CREATE TABLE IF NOT EXISTS mail_notes (
  id SERIAL PRIMARY KEY,
  mail_id INTEGER NOT NULL REFERENCES mails(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mail_notes_mail_id ON mail_notes(mail_id);
CREATE INDEX IF NOT EXISTS idx_mail_notes_tenant_id ON mail_notes(tenant_id);

-- Activity log table
CREATE TABLE IF NOT EXISTS mail_activities (
  id SERIAL PRIMARY KEY,
  mail_id INTEGER NOT NULL REFERENCES mails(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action VARCHAR(50) NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mail_activities_mail_id ON mail_activities(mail_id);
CREATE INDEX IF NOT EXISTS idx_mail_activities_tenant_id ON mail_activities(tenant_id);
CREATE INDEX IF NOT EXISTS idx_mail_activities_created_at ON mail_activities(created_at DESC);

-- Quick reply templates (already exists in schema_upgrade.sql, just reference)
-- Templates table is already created

-- Function to generate thread_id from subject
CREATE OR REPLACE FUNCTION normalize_subject(subject TEXT) RETURNS TEXT AS $$
BEGIN
  RETURN LOWER(REGEXP_REPLACE(
    REGEXP_REPLACE(subject, '^(Re:|Fwd:|RE:|FW:)\s*', '', 'gi'),
    '\s+', ' ', 'g'
  ));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Update existing mails with thread_id based on normalized subject
UPDATE mails 
SET thread_id = MD5(normalize_subject(COALESCE(subject, '')))
WHERE thread_id IS NULL;
