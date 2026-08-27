-- WhatsApp ready-template library: per-account install tracking + PAUSED + rejection reason
-- Idempotent / safe for re-run. Does not delete or merge template rows.
-- Unique index is skipped (with NOTICE) if duplicate (tenant_id, provider_waba_id, library_key) rows exist.

ALTER TABLE templates ADD COLUMN IF NOT EXISTS library_key VARCHAR(64);
ALTER TABLE templates ADD COLUMN IF NOT EXISTS provider_rejection_reason TEXT;

-- Expand CHECK only after verifying existing values are compatible (NULL or known set).
DO $$
DECLARE
  bad_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad_count
  FROM templates
  WHERE provider_approval_status IS NOT NULL
    AND provider_approval_status NOT IN ('UNKNOWN', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED');

  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'templates_provider_approval_status_check blocked: % row(s) have unsupported provider_approval_status. Fix or map those values before migrating.',
      bad_count;
  END IF;

  ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_provider_approval_status_check;
  ALTER TABLE templates
    ADD CONSTRAINT templates_provider_approval_status_check
    CHECK (
      provider_approval_status IS NULL
      OR provider_approval_status IN ('UNKNOWN', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED')
    );
END $$;

-- One catalog install per tenant + WhatsApp account (provider_waba_id). Skip if duplicates exist.
DO $$
DECLARE
  dup_count INTEGER;
  sample TEXT;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT 1
    FROM templates
    WHERE library_key IS NOT NULL AND provider_waba_id IS NOT NULL
    GROUP BY tenant_id, provider_waba_id, library_key
    HAVING COUNT(*) > 1
  ) d;

  IF dup_count > 0 THEN
    SELECT string_agg(
      format('tenant=%s waba=%s key=%s n=%s ids=%s', tenant_id, provider_waba_id, library_key, n, ids),
      E'\n'
    )
    INTO sample
    FROM (
      SELECT tenant_id, provider_waba_id, library_key, COUNT(*) AS n,
             array_agg(id ORDER BY id)::text AS ids
      FROM templates
      WHERE library_key IS NOT NULL AND provider_waba_id IS NOT NULL
      GROUP BY tenant_id, provider_waba_id, library_key
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
      LIMIT 20
    ) s;

    RAISE NOTICE
      'SKIP idx_templates_library_key_waba: % duplicate group(s). No rows deleted/merged. Sample:%',
      dup_count,
      E'\n' || COALESCE(sample, '');
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_library_key_waba
      ON templates (tenant_id, provider_waba_id, library_key)
      WHERE library_key IS NOT NULL AND provider_waba_id IS NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_templates_library_key
  ON templates (tenant_id, library_key)
  WHERE library_key IS NOT NULL;
