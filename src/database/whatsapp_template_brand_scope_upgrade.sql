-- Re-scope ready-template library unique index to include brand_id.
-- Enables per-brand local installs on a shared WABA without duplicate Meta submissions.
-- Idempotent / safe for re-run. Does not UPDATE, DELETE, or copy template rows.

DROP INDEX IF EXISTS idx_templates_library_key_waba;

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
    GROUP BY tenant_id, brand_id, provider_waba_id, library_key
    HAVING COUNT(*) > 1
  ) d;

  IF dup_count > 0 THEN
    SELECT string_agg(
      format(
        'tenant=%s brand=%s waba=%s key=%s n=%s ids=%s',
        tenant_id, brand_id, provider_waba_id, library_key, n, ids
      ),
      E'\n'
    )
    INTO sample
    FROM (
      SELECT tenant_id, brand_id, provider_waba_id, library_key, COUNT(*) AS n,
             array_agg(id ORDER BY id)::text AS ids
      FROM templates
      WHERE library_key IS NOT NULL AND provider_waba_id IS NOT NULL
      GROUP BY tenant_id, brand_id, provider_waba_id, library_key
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
      LIMIT 20
    ) s;

    RAISE EXCEPTION
      'idx_templates_library_key_waba blocked: % duplicate group(s) on (tenant_id, brand_id, provider_waba_id, library_key). Sample:%',
      dup_count,
      E'\n' || COALESCE(sample, '');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_library_key_waba
  ON templates (tenant_id, brand_id, provider_waba_id, library_key)
  WHERE library_key IS NOT NULL AND provider_waba_id IS NOT NULL;

COMMENT ON INDEX idx_templates_library_key_waba IS
  'One ready-library install per tenant + brand + WABA + catalog key.';
