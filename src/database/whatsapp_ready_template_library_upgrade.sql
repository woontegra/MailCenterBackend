-- WhatsApp ready-template library: per-WABA install tracking + PAUSED + rejection reason

ALTER TABLE templates ADD COLUMN IF NOT EXISTS library_key VARCHAR(64);
ALTER TABLE templates ADD COLUMN IF NOT EXISTS provider_rejection_reason TEXT;

ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_provider_approval_status_check;
ALTER TABLE templates
  ADD CONSTRAINT templates_provider_approval_status_check
  CHECK (
    provider_approval_status IS NULL
    OR provider_approval_status IN ('UNKNOWN', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED')
  );

-- One catalog install per tenant + WABA (global catalog key is not shared across WABAs)
CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_library_key_waba
  ON templates (tenant_id, provider_waba_id, library_key)
  WHERE library_key IS NOT NULL AND provider_waba_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_templates_library_key
  ON templates (tenant_id, library_key)
  WHERE library_key IS NOT NULL;
