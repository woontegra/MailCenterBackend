-- WhatsApp bulk template campaigns (extends existing campaigns + recipients)

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS channel_type VARCHAR(20) NOT NULL DEFAULT 'EMAIL';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS channel_connection_id INTEGER
  REFERENCES channel_connections(id) ON DELETE SET NULL;

ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_channel_type_check;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_channel_type_check
  CHECK (channel_type IN ('EMAIL', 'WHATSAPP'));

CREATE INDEX IF NOT EXISTS idx_campaigns_channel_type
  ON campaigns(tenant_id, channel_type, status);

ALTER TABLE campaign_recipients ALTER COLUMN email DROP NOT NULL;
ALTER TABLE campaign_recipients ALTER COLUMN email_normalized DROP NOT NULL;

ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS phone VARCHAR(80);
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS phone_normalized VARCHAR(80);
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS skip_reason VARCHAR(80);

CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_recipients_phone
  ON campaign_recipients(campaign_id, phone_normalized)
  WHERE phone_normalized IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_campaign_recipients_phone_status
  ON campaign_recipients(campaign_id, phone_normalized, status);
