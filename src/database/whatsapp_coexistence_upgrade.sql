-- WhatsApp Business app coexistence: raw webhook event store, SMB app data sync tracking,
-- origin markers for history / echo messages. Idempotent, additive only.

-- ALTER TABLE on outbound/inbound_messages needs a brief exclusive lock; fail fast (and roll
-- back) rather than queueing behind a long-running query and blocking live traffic.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS whatsapp_webhook_events (
  id BIGSERIAL PRIMARY KEY,
  dedupe_key VARCHAR(64) NOT NULL,
  field VARCHAR(40) NOT NULL,
  event_name VARCHAR(60),
  waba_id VARCHAR(64),
  phone_number_id VARCHAR(64),
  payload JSONB NOT NULL,
  signature_source VARCHAR(20) NOT NULL DEFAULT 'PLATFORM'
    CHECK (signature_source IN ('PLATFORM', 'CONNECTION')),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'PROCESSED', 'IGNORED', 'FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error VARCHAR(500),
  result JSONB,
  locked_at TIMESTAMP,
  received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_webhook_events_dedupe
  ON whatsapp_webhook_events(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_whatsapp_webhook_events_status
  ON whatsapp_webhook_events(status, id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_webhook_events_phone
  ON whatsapp_webhook_events(phone_number_id, field);
CREATE INDEX IF NOT EXISTS idx_whatsapp_webhook_events_waba
  ON whatsapp_webhook_events(waba_id, field);

CREATE TABLE IF NOT EXISTS whatsapp_coexistence_sync_requests (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_connection_id INTEGER NOT NULL REFERENCES channel_connections(id) ON DELETE CASCADE,
  phone_number_id VARCHAR(64) NOT NULL,
  onboarding_key VARCHAR(64) NOT NULL,
  sync_type VARCHAR(20) NOT NULL CHECK (sync_type IN ('CONTACTS', 'HISTORY')),
  status VARCHAR(20) NOT NULL DEFAULT 'REQUESTING'
    CHECK (status IN (
      'REQUESTING', 'REQUESTED', 'UNCERTAIN', 'IN_PROGRESS', 'COMPLETED', 'DECLINED', 'FAILED'
    )),
  request_id VARCHAR(191),
  attempts INTEGER NOT NULL DEFAULT 1,
  progress INTEGER,
  last_phase INTEGER,
  chunks_received INTEGER NOT NULL DEFAULT 0,
  items_received INTEGER NOT NULL DEFAULT 0,
  items_imported INTEGER NOT NULL DEFAULT 0,
  items_skipped INTEGER NOT NULL DEFAULT 0,
  last_error_code VARCHAR(100),
  last_error_message VARCHAR(500),
  requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at TIMESTAMP,
  last_event_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_coexistence_sync_once
  ON whatsapp_coexistence_sync_requests(channel_connection_id, onboarding_key, sync_type);
CREATE INDEX IF NOT EXISTS idx_whatsapp_coexistence_sync_tenant
  ON whatsapp_coexistence_sync_requests(tenant_id, channel_connection_id);

-- API = sent through MailCenter queue (billable); BUSINESS_APP_ECHO / HISTORY_SYNC are
-- imported from the WhatsApp Business app and never consume usage.
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS origin VARCHAR(30) NOT NULL DEFAULT 'API';
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS provider_metadata JSONB;
CREATE INDEX IF NOT EXISTS idx_outbound_messages_tenant_provider_msg
  ON outbound_messages(tenant_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

ALTER TABLE inbound_messages ADD COLUMN IF NOT EXISTS origin VARCHAR(30) NOT NULL DEFAULT 'WEBHOOK';
