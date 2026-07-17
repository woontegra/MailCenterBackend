-- Block-based email template editor fields (idempotent, non-destructive)
ALTER TABLE templates ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS preheader TEXT;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS editor_json JSONB DEFAULT NULL;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS is_draft BOOLEAN DEFAULT true;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS template_kind VARCHAR(20) DEFAULT 'INDIVIDUAL';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'templates_template_kind_check'
  ) THEN
    ALTER TABLE templates
      ADD CONSTRAINT templates_template_kind_check
      CHECK (template_kind IN ('INDIVIDUAL', 'BULK'));
  END IF;
END $$;

-- Existing active templates are treated as published (not draft)
UPDATE templates
SET is_draft = false
WHERE is_draft IS NULL OR (COALESCE(is_active, true) = true AND editor_json IS NULL);

UPDATE templates
SET template_kind = 'INDIVIDUAL'
WHERE template_kind IS NULL;

CREATE INDEX IF NOT EXISTS idx_templates_is_draft ON templates(tenant_id, is_draft);
CREATE INDEX IF NOT EXISTS idx_templates_editor_json ON templates((editor_json IS NOT NULL));
