-- Enterprise Features Upgrade

-- 1. FEATURE FLAGS TABLE
CREATE TABLE IF NOT EXISTS feature_flags (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  enabled BOOLEAN DEFAULT false,
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. WEBHOOKS TABLE
CREATE TABLE IF NOT EXISTS webhooks (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  events TEXT[] NOT NULL,
  secret VARCHAR(255),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. WEBHOOK LOGS TABLE
CREATE TABLE IF NOT EXISTS webhook_logs (
  id SERIAL PRIMARY KEY,
  webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,
  payload JSONB NOT NULL,
  response_status INTEGER,
  response_body TEXT,
  error TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. WHITE-LABEL SETTINGS
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS primary_color VARCHAR(7) DEFAULT '#3B82F6';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS secondary_color VARCHAR(7) DEFAULT '#1E40AF';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS custom_domain VARCHAR(255);

-- 5. ATTACHMENT STORAGE
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS storage_provider VARCHAR(20) DEFAULT 'local' CHECK (storage_provider IN ('local', 's3', 'r2'));
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS storage_key TEXT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS storage_url TEXT;

-- 6. MAIL SEARCH INDEX
CREATE INDEX IF NOT EXISTS idx_mails_search_subject ON mails USING gin(to_tsvector('english', subject));
CREATE INDEX IF NOT EXISTS idx_mails_search_body ON mails USING gin(to_tsvector('english', body_preview));
CREATE INDEX IF NOT EXISTS idx_mails_search_from ON mails USING gin(to_tsvector('english', from_address));

-- 7. JOB QUEUE TRACKING
CREATE TABLE IF NOT EXISTS job_logs (
  id SERIAL PRIMARY KEY,
  job_id VARCHAR(255) NOT NULL,
  job_type VARCHAR(50) NOT NULL,
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts INTEGER DEFAULT 0,
  error TEXT,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 8. RATE LIMIT TRACKING
CREATE TABLE IF NOT EXISTS rate_limits (
  id SERIAL PRIMARY KEY,
  identifier VARCHAR(255) NOT NULL,
  endpoint VARCHAR(255) NOT NULL,
  count INTEGER DEFAULT 1,
  reset_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(identifier, endpoint)
);

-- 9. INDEXES FOR PERFORMANCE
CREATE INDEX IF NOT EXISTS idx_feature_flags_tenant_id ON feature_flags(tenant_id);
CREATE INDEX IF NOT EXISTS idx_feature_flags_name ON feature_flags(name);
CREATE INDEX IF NOT EXISTS idx_webhooks_tenant_id ON webhooks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_is_active ON webhooks(is_active);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_webhook_id ON webhook_logs(webhook_id);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_created_at ON webhook_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_logs_tenant_id ON job_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_job_logs_status ON job_logs(status);
CREATE INDEX IF NOT EXISTS idx_job_logs_created_at ON job_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rate_limits_identifier ON rate_limits(identifier);
CREATE INDEX IF NOT EXISTS idx_rate_limits_reset_at ON rate_limits(reset_at);
