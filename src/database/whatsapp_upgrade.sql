-- WhatsApp Cloud API foundation (idempotent, non-destructive)

-- Outbound statuses: delivery lifecycle for WhatsApp (and future channels)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'outbound_messages_status_check'
  ) THEN
    ALTER TABLE outbound_messages DROP CONSTRAINT outbound_messages_status_check;
  END IF;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;

ALTER TABLE outbound_messages
  DROP CONSTRAINT IF EXISTS outbound_messages_status_check;

ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_status_check
  CHECK (status IN (
    'QUEUED', 'PROCESSING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'CANCELLED', 'SCHEDULED'
  ));

-- Template Meta binding fields (reuse templates table)
ALTER TABLE templates ADD COLUMN IF NOT EXISTS provider_template_name VARCHAR(255);
ALTER TABLE templates ADD COLUMN IF NOT EXISTS provider_template_language VARCHAR(20);
ALTER TABLE templates ADD COLUMN IF NOT EXISTS provider_approval_status VARCHAR(20)
  DEFAULT 'UNKNOWN';
ALTER TABLE templates ADD COLUMN IF NOT EXISTS provider_template_components JSONB DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'templates_provider_approval_status_check'
  ) THEN
    ALTER TABLE templates
      ADD CONSTRAINT templates_provider_approval_status_check
      CHECK (
        provider_approval_status IS NULL
        OR provider_approval_status IN ('UNKNOWN', 'PENDING', 'APPROVED', 'REJECTED')
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_templates_provider_template_name
  ON templates(tenant_id, provider_template_name)
  WHERE provider_template_name IS NOT NULL;

-- Inbound messages (WhatsApp and future channels; not mails table)
CREATE TABLE IF NOT EXISTS inbound_messages (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
  channel_connection_id INTEGER REFERENCES channel_connections(id) ON DELETE SET NULL,
  channel_type VARCHAR(20) NOT NULL CHECK (channel_type IN ('EMAIL', 'SMS', 'WHATSAPP')),
  sender_value VARCHAR(320) NOT NULL,
  recipient_value VARCHAR(320),
  provider_message_id VARCHAR(500) NOT NULL,
  message_type VARCHAR(50) NOT NULL DEFAULT 'text',
  content TEXT,
  media_metadata JSONB DEFAULT '{}'::jsonb,
  received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'RECEIVED'
    CHECK (status IN ('RECEIVED', 'PROCESSED', 'IGNORED', 'ERROR')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_messages_tenant_provider_msg
  ON inbound_messages(tenant_id, channel_type, provider_message_id);

CREATE INDEX IF NOT EXISTS idx_inbound_messages_tenant_received
  ON inbound_messages(tenant_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_inbound_messages_connection
  ON inbound_messages(channel_connection_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_inbound_messages_contact
  ON inbound_messages(tenant_id, contact_id);

CREATE INDEX IF NOT EXISTS idx_inbound_messages_sender
  ON inbound_messages(tenant_id, channel_type, sender_value);

-- Lookup WhatsApp connections by Phone Number ID (stored in settings)
CREATE INDEX IF NOT EXISTS idx_channel_connections_wa_phone_number_id
  ON channel_connections ((settings->>'phone_number_id'))
  WHERE channel_type = 'WHATSAPP';
