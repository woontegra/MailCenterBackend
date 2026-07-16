-- Domain deliverability health checks (idempotent, non-destructive)
-- Uses existing brands; does not create a second brands table.

CREATE TABLE IF NOT EXISTS domain_health_checks (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  domain VARCHAR(255),
  spf_status VARCHAR(20) NOT NULL DEFAULT 'NOT_CHECKED',
  spf_record TEXT,
  dkim_status VARCHAR(20) NOT NULL DEFAULT 'NOT_CHECKED',
  dkim_selector VARCHAR(100),
  dkim_record TEXT,
  dmarc_status VARCHAR(20) NOT NULL DEFAULT 'NOT_CHECKED',
  dmarc_record TEXT,
  mx_status VARCHAR(20) NOT NULL DEFAULT 'NOT_CHECKED',
  mx_records JSONB DEFAULT '[]'::jsonb,
  last_checked_at TIMESTAMP,
  overall_status VARCHAR(20) NOT NULL DEFAULT 'NOT_CHECKED',
  warnings JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'domain_health_checks_spf_status_check'
  ) THEN
    ALTER TABLE domain_health_checks
      ADD CONSTRAINT domain_health_checks_spf_status_check
      CHECK (spf_status IN ('NOT_CHECKED', 'VALID', 'WARNING', 'INVALID', 'ERROR'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'domain_health_checks_dkim_status_check'
  ) THEN
    ALTER TABLE domain_health_checks
      ADD CONSTRAINT domain_health_checks_dkim_status_check
      CHECK (dkim_status IN ('NOT_CHECKED', 'VALID', 'WARNING', 'INVALID', 'ERROR'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'domain_health_checks_dmarc_status_check'
  ) THEN
    ALTER TABLE domain_health_checks
      ADD CONSTRAINT domain_health_checks_dmarc_status_check
      CHECK (dmarc_status IN ('NOT_CHECKED', 'VALID', 'WARNING', 'INVALID', 'ERROR'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'domain_health_checks_mx_status_check'
  ) THEN
    ALTER TABLE domain_health_checks
      ADD CONSTRAINT domain_health_checks_mx_status_check
      CHECK (mx_status IN ('NOT_CHECKED', 'VALID', 'WARNING', 'INVALID', 'ERROR'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'domain_health_checks_overall_status_check'
  ) THEN
    ALTER TABLE domain_health_checks
      ADD CONSTRAINT domain_health_checks_overall_status_check
      CHECK (overall_status IN ('NOT_CHECKED', 'VALID', 'WARNING', 'INVALID', 'ERROR'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_domain_health_checks_tenant_brand
  ON domain_health_checks(tenant_id, brand_id);

CREATE INDEX IF NOT EXISTS idx_domain_health_checks_tenant_id
  ON domain_health_checks(tenant_id);

CREATE INDEX IF NOT EXISTS idx_domain_health_checks_brand_id
  ON domain_health_checks(brand_id);

CREATE INDEX IF NOT EXISTS idx_domain_health_checks_overall_status
  ON domain_health_checks(overall_status);

-- Seed empty health rows for existing brands (do not alter sender is_verified)
INSERT INTO domain_health_checks (tenant_id, brand_id, domain, overall_status)
SELECT b.tenant_id, b.id, NULLIF(TRIM(b.domain), ''), 'NOT_CHECKED'
FROM brands b
WHERE NOT EXISTS (
  SELECT 1 FROM domain_health_checks d
  WHERE d.tenant_id = b.tenant_id AND d.brand_id = b.id
);
