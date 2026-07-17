-- Campaign recipient management: reusable segments, imports, suppression, unsubscribe tokens
-- Idempotent and non-destructive.

CREATE TABLE IF NOT EXISTS campaign_segments (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_segments_tenant_name
  ON campaign_segments(tenant_id, LOWER(name));

CREATE INDEX IF NOT EXISTS idx_campaign_segments_tenant
  ON campaign_segments(tenant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS email_suppressions (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email VARCHAR(320) NOT NULL,
  email_normalized VARCHAR(320) NOT NULL,
  reason VARCHAR(40) NOT NULL
    CHECK (reason IN ('UNSUBSCRIBED', 'BOUNCE_PERMANENT', 'SPAM_COMPLAINT', 'ADMIN_BLOCKED', 'INVALID_ADDRESS')),
  source VARCHAR(80) NOT NULL DEFAULT 'manual',
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_email_suppressions_tenant_email
  ON email_suppressions(tenant_id, email_normalized);

CREATE INDEX IF NOT EXISTS idx_email_suppressions_tenant_reason
  ON email_suppressions(tenant_id, reason, created_at DESC);

CREATE TABLE IF NOT EXISTS campaign_recipient_imports (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  filename VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'PREVIEW'
    CHECK (status IN ('PREVIEW', 'APPLIED', 'FAILED')),
  mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
  options JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_campaign_imports_campaign
  ON campaign_recipient_imports(tenant_id, campaign_id, created_at DESC);

CREATE TABLE IF NOT EXISTS campaign_recipient_import_rows (
  id SERIAL PRIMARY KEY,
  import_id INTEGER NOT NULL REFERENCES campaign_recipient_imports(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_name VARCHAR(120),
  last_name VARCHAR(120),
  email VARCHAR(320),
  email_normalized VARCHAR(320),
  phone VARCHAR(80),
  company_name VARCHAR(255),
  tags TEXT[],
  status VARCHAR(30) NOT NULL DEFAULT 'VALID'
    CHECK (status IN ('VALID', 'MISSING_EMAIL', 'INVALID_EMAIL', 'DUPLICATE_IN_FILE', 'EXISTING_CONTACT', 'SUPPRESSED')),
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  suppression_reason VARCHAR(40),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_campaign_import_rows_import_status
  ON campaign_recipient_import_rows(import_id, status);

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS recipient_summary JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS source VARCHAR(40) DEFAULT 'audience';
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS source_ref_id INTEGER;

CREATE TABLE IF NOT EXISTS campaign_unsubscribe_tokens (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  campaign_recipient_id INTEGER NOT NULL REFERENCES campaign_recipients(id) ON DELETE CASCADE,
  email_normalized VARCHAR(320) NOT NULL,
  token_hash VARCHAR(128) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_unsubscribe_recipient
  ON campaign_unsubscribe_tokens(tenant_id, campaign_recipient_id);

CREATE TABLE IF NOT EXISTS campaign_unsubscribe_events (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  campaign_recipient_id INTEGER REFERENCES campaign_recipients(id) ON DELETE SET NULL,
  email_normalized VARCHAR(320) NOT NULL,
  suppression_id INTEGER REFERENCES email_suppressions(id) ON DELETE SET NULL,
  ip_hash VARCHAR(128),
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_campaign_unsubscribe_events_tenant
  ON campaign_unsubscribe_events(tenant_id, created_at DESC);
