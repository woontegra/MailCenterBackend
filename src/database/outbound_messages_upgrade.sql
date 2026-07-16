-- Multi-tenant outbound message queue foundation (idempotent, non-destructive)

CREATE TABLE IF NOT EXISTS outbound_messages (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
  channel_type VARCHAR(20) NOT NULL CHECK (channel_type IN ('EMAIL', 'SMS', 'WHATSAPP')),
  sender_identity_id INTEGER REFERENCES sender_identities(id) ON DELETE SET NULL,
  template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
  draft_id INTEGER REFERENCES drafts(id) ON DELETE SET NULL,
  recipient_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  subject TEXT,
  html_content TEXT,
  plain_text_content TEXT,
  message_content TEXT,
  template_variables JSONB DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED', 'SCHEDULED')),
  priority INTEGER NOT NULL DEFAULT 0,
  scheduled_at TIMESTAMP,
  idempotency_key VARCHAR(191) NOT NULL,
  provider_message_id VARCHAR(500),
  last_error_code VARCHAR(100),
  last_error_message VARCHAR(500),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  queued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  sent_at TIMESTAMP,
  failed_at TIMESTAMP,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_messages_tenant_idempotency
  ON outbound_messages(tenant_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_outbound_messages_tenant_id ON outbound_messages(tenant_id);
CREATE INDEX IF NOT EXISTS idx_outbound_messages_status ON outbound_messages(status);
CREATE INDEX IF NOT EXISTS idx_outbound_messages_brand_id ON outbound_messages(brand_id);
CREATE INDEX IF NOT EXISTS idx_outbound_messages_sender_identity_id ON outbound_messages(sender_identity_id);
CREATE INDEX IF NOT EXISTS idx_outbound_messages_queued_at ON outbound_messages(queued_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbound_messages_channel_type ON outbound_messages(channel_type);

CREATE TABLE IF NOT EXISTS outbound_message_attempts (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  outbound_message_id INTEGER NOT NULL REFERENCES outbound_messages(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL
    CHECK (status IN ('PROCESSING', 'SENT', 'FAILED', 'DELAYED')),
  provider VARCHAR(100),
  error_code VARCHAR(100),
  safe_error_message VARCHAR(500),
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_outbound_attempts_tenant_id ON outbound_message_attempts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_outbound_attempts_message_id ON outbound_message_attempts(outbound_message_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_attempts_message_number
  ON outbound_message_attempts(outbound_message_id, attempt_number);
