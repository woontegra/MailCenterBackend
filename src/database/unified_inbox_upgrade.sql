-- Unified multi-channel communication inbox (idempotent, non-destructive)
-- Extends existing conversations table; does not drop email data.

-- Make subject optional (SMS/WhatsApp may not have subject)
ALTER TABLE conversations ALTER COLUMN subject DROP NOT NULL;

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel_type VARCHAR(20);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel_connection_id INTEGER REFERENCES channel_connections(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS participant_value VARCHAR(320);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS normalized_participant_value VARCHAR(320);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'OPEN';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS priority VARCHAR(20) DEFAULT 'NORMAL';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMP;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_outbound_at TIMESTAMP;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS unread_count INTEGER NOT NULL DEFAULT 0;

-- Backfill channel_type for legacy email conversations
UPDATE conversations
SET channel_type = 'EMAIL'
WHERE channel_type IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_channel_type_check'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_channel_type_check
      CHECK (channel_type IS NULL OR channel_type IN ('EMAIL', 'SMS', 'WHATSAPP'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_status_check'
  ) THEN
    ALTER TABLE conversations DROP CONSTRAINT conversations_status_check;
  END IF;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_status_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_status_check
  CHECK (status IN ('OPEN', 'WAITING_REPLY', 'RESOLVED', 'ARCHIVED'));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_priority_check'
  ) THEN
    ALTER TABLE conversations DROP CONSTRAINT conversations_priority_check;
  END IF;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_priority_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_priority_check
  CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT'));

UPDATE conversations SET status = 'OPEN' WHERE status IS NULL;
UPDATE conversations SET priority = 'NORMAL' WHERE priority IS NULL;

ALTER TABLE conversations ALTER COLUMN status SET DEFAULT 'OPEN';
ALTER TABLE conversations ALTER COLUMN priority SET DEFAULT 'NORMAL';

CREATE INDEX IF NOT EXISTS idx_conversations_tenant_last_message
  ON conversations(tenant_id, last_message_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_conversations_tenant_status
  ON conversations(tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_conversations_tenant_channel
  ON conversations(tenant_id, channel_type);

CREATE INDEX IF NOT EXISTS idx_conversations_tenant_brand
  ON conversations(tenant_id, brand_id);

CREATE INDEX IF NOT EXISTS idx_conversations_tenant_assigned
  ON conversations(tenant_id, assigned_user_id);

CREATE INDEX IF NOT EXISTS idx_conversations_tenant_contact
  ON conversations(tenant_id, contact_id);

CREATE INDEX IF NOT EXISTS idx_conversations_tenant_unread
  ON conversations(tenant_id, unread_count)
  WHERE unread_count > 0;

CREATE INDEX IF NOT EXISTS idx_conversations_wa_participant
  ON conversations(tenant_id, channel_type, channel_connection_id, normalized_participant_value)
  WHERE channel_type IN ('WHATSAPP', 'SMS') AND normalized_participant_value IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_email_participant
  ON conversations(tenant_id, channel_type, normalized_participant_value)
  WHERE channel_type = 'EMAIL' AND normalized_participant_value IS NOT NULL;

-- Link channel message sources without copying content
ALTER TABLE inbound_messages
  ADD COLUMN IF NOT EXISTS conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inbound_messages_conversation
  ON inbound_messages(conversation_id, received_at);

ALTER TABLE outbound_messages
  ADD COLUMN IF NOT EXISTS conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_outbound_messages_conversation
  ON outbound_messages(conversation_id, created_at);

-- Conversation-scoped internal notes (never sent to recipients)
CREATE TABLE IF NOT EXISTS conversation_notes (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conversation_notes_conversation
  ON conversation_notes(conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversation_notes_tenant
  ON conversation_notes(tenant_id, created_at DESC);
