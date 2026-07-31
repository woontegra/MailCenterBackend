-- Provider WABA scoping so templates from Meta test WABA do not mix with coexistence WABA
ALTER TABLE templates ADD COLUMN IF NOT EXISTS provider_waba_id VARCHAR(64);
ALTER TABLE templates ADD COLUMN IF NOT EXISTS channel_connection_id INTEGER
  REFERENCES channel_connections(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_templates_provider_waba_id
  ON templates(tenant_id, provider_waba_id)
  WHERE provider_waba_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_templates_channel_connection_id
  ON templates(tenant_id, channel_connection_id)
  WHERE channel_connection_id IS NOT NULL;
