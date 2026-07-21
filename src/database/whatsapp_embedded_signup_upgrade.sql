-- WhatsApp Embedded Signup / connection metadata helpers (idempotent)
-- Core credentials remain in encrypted_credentials; Meta IDs live in settings JSONB.

CREATE INDEX IF NOT EXISTS idx_channel_connections_wa_waba_id
  ON channel_connections ((settings->>'waba_id'))
  WHERE channel_type = 'WHATSAPP' AND settings->>'waba_id' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_channel_connections_wa_phone_number_id_active
  ON channel_connections ((settings->>'phone_number_id'))
  WHERE channel_type = 'WHATSAPP'
    AND status = 'ACTIVE'
    AND settings->>'phone_number_id' IS NOT NULL;
