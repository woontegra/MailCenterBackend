-- Extend drafts for brand/sender/template compose flow (idempotent, non-destructive)

ALTER TABLE drafts ADD COLUMN IF NOT EXISTS brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS channel_type VARCHAR(20);
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS sender_identity_id INTEGER REFERENCES sender_identities(id) ON DELETE SET NULL;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS html_content TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS plain_text_content TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS template_variables JSONB DEFAULT '{}'::jsonb;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'draft';
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS reply_to VARCHAR(320);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'drafts_channel_type_check'
  ) THEN
    ALTER TABLE drafts
      ADD CONSTRAINT drafts_channel_type_check
      CHECK (channel_type IS NULL OR channel_type IN ('EMAIL', 'SMS', 'WHATSAPP'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'drafts_status_check'
  ) THEN
    ALTER TABLE drafts
      ADD CONSTRAINT drafts_status_check
      CHECK (status IS NULL OR status IN ('draft', 'sent', 'deleted'));
  END IF;
END $$;

-- Backfill plain/html from legacy body when empty
UPDATE drafts
SET plain_text_content = COALESCE(plain_text_content, body),
    html_content = COALESCE(html_content, NULLIF(body, ''))
WHERE (plain_text_content IS NULL OR plain_text_content = '')
   OR (html_content IS NULL OR html_content = '');

UPDATE drafts
SET channel_type = 'EMAIL'
WHERE channel_type IS NULL;

UPDATE drafts
SET status = 'draft'
WHERE status IS NULL;

UPDATE drafts
SET template_variables = '{}'::jsonb
WHERE template_variables IS NULL;

CREATE INDEX IF NOT EXISTS idx_drafts_brand_id ON drafts(brand_id);
CREATE INDEX IF NOT EXISTS idx_drafts_sender_identity_id ON drafts(sender_identity_id);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
CREATE INDEX IF NOT EXISTS idx_drafts_template_id ON drafts(template_id);

-- Mark sender identities verified when linked to ACTIVE email connection + active mail account
UPDATE sender_identities si
SET is_verified = true,
    updated_at = CURRENT_TIMESTAMP
FROM channel_connections cc
JOIN mail_accounts ma ON ma.id = cc.mail_account_id AND ma.tenant_id = cc.tenant_id
WHERE si.channel_connection_id = cc.id
  AND si.tenant_id = cc.tenant_id
  AND si.channel_type = 'EMAIL'
  AND cc.channel_type = 'EMAIL'
  AND cc.status = 'ACTIVE'
  AND ma.is_active = true
  AND si.is_verified IS DISTINCT FROM true;
