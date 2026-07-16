-- SaaS platform plans, usage, tenant status (idempotent, non-destructive)

-- Tenant lifecycle status (separate from is_active)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'ACTIVE';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS entitlement_version INTEGER NOT NULL DEFAULT 1;

UPDATE tenants
SET status = CASE
  WHEN COALESCE(is_active, true) = false THEN 'SUSPENDED'
  ELSE COALESCE(NULLIF(status, ''), 'ACTIVE')
END
WHERE status IS NULL OR status = 'ACTIVE';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_status_check') THEN
    ALTER TABLE tenants DROP CONSTRAINT tenants_status_check;
  END IF;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_status_check;
ALTER TABLE tenants
  ADD CONSTRAINT tenants_status_check
  CHECK (status IN ('ACTIVE', 'SUSPENDED', 'ARCHIVED'));

-- Extend plans catalog
ALTER TABLE plans ADD COLUMN IF NOT EXISTS code VARCHAR(50);
ALTER TABLE plans ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT true;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'USD';
ALTER TABLE plans ADD COLUMN IF NOT EXISTS limits JSONB DEFAULT '{}'::jsonb;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS monthly_price DECIMAL(10,2);
ALTER TABLE plans ADD COLUMN IF NOT EXISTS yearly_price DECIMAL(10,2);

UPDATE plans SET code = UPPER(name) WHERE code IS NULL;
UPDATE plans SET monthly_price = COALESCE(monthly_price, price_monthly);
UPDATE plans SET yearly_price = COALESCE(yearly_price, price_yearly);

-- Map legacy plan rows onto modern codes before unique index / seed
UPDATE plans SET code = 'STARTER' WHERE LOWER(name) = 'starter';
UPDATE plans
SET code = 'PROFESSIONAL',
    display_name = COALESCE(NULLIF(display_name, ''), 'Professional')
WHERE LOWER(name) IN ('pro', 'professional');
UPDATE plans SET code = 'ENTERPRISE' WHERE LOWER(name) = 'enterprise';
UPDATE plans SET code = 'INTERNAL' WHERE LOWER(name) = 'internal';
UPDATE plans SET code = 'BUSINESS' WHERE LOWER(name) = 'business';
UPDATE plans SET code = 'CUSTOM' WHERE LOWER(name) = 'custom';

-- Collapse accidental duplicate plan codes (keep lowest id)
DELETE FROM plans a
USING plans b
WHERE a.id > b.id
  AND a.code IS NOT NULL
  AND b.code IS NOT NULL
  AND UPPER(a.code) = UPPER(b.code);

CREATE UNIQUE INDEX IF NOT EXISTS uq_plans_code ON plans(code) WHERE code IS NOT NULL;

-- Idempotent plan catalog upsert by code (null limit = unlimited)
DROP TABLE IF EXISTS _plan_seed;
CREATE TEMP TABLE _plan_seed (
  name TEXT,
  code TEXT,
  display_name TEXT,
  description TEXT,
  price_monthly NUMERIC,
  price_yearly NUMERIC,
  currency TEXT,
  is_active BOOLEAN,
  is_public BOOLEAN,
  max_accounts INT,
  max_users INT,
  max_daily_fetch INT,
  max_storage_mb INT,
  limits JSONB,
  features JSONB
);
INSERT INTO _plan_seed VALUES
(
  'internal', 'INTERNAL', 'Internal', 'Woontegra internal tenant plan',
  0, 0, 'USD', true, false, 999999, 999999, 999999, 999999,
  '{"max_users":null,"max_brands":null,"max_email_accounts":null,"max_sms_connections":null,"max_whatsapp_connections":null,"max_sender_identities":null,"max_contacts":null,"max_templates":null,"monthly_email_sends":null,"monthly_sms_sends":null,"monthly_whatsapp_sends":null,"storage_bytes":null}'::jsonb,
  '{"automation":true,"unified_inbox":true,"deliverability":true,"advanced_analytics":true,"white_label":true,"api_webhooks":true,"priority_support":true}'::jsonb
),
(
  'starter', 'STARTER', 'Starter', 'Small teams getting started',
  9.99, 99.99, 'USD', true, true, 3, 3, 1000, 1024,
  '{"max_users":3,"max_brands":2,"max_email_accounts":3,"max_sms_connections":1,"max_whatsapp_connections":1,"max_sender_identities":5,"max_contacts":1000,"max_templates":20,"monthly_email_sends":2000,"monthly_sms_sends":200,"monthly_whatsapp_sends":200,"storage_bytes":1073741824}'::jsonb,
  '{"automation":false,"unified_inbox":true,"deliverability":true,"advanced_analytics":false,"white_label":false,"api_webhooks":false,"priority_support":false}'::jsonb
),
(
  'professional', 'PROFESSIONAL', 'Professional', 'Growing teams',
  29.99, 299.99, 'USD', true, true, 10, 15, 10000, 10240,
  '{"max_users":15,"max_brands":10,"max_email_accounts":10,"max_sms_connections":3,"max_whatsapp_connections":3,"max_sender_identities":25,"max_contacts":25000,"max_templates":100,"monthly_email_sends":25000,"monthly_sms_sends":5000,"monthly_whatsapp_sends":5000,"storage_bytes":10737418240}'::jsonb,
  '{"automation":true,"unified_inbox":true,"deliverability":true,"advanced_analytics":true,"white_label":false,"api_webhooks":true,"priority_support":false}'::jsonb
),
(
  'business', 'BUSINESS', 'Business', 'Multi-brand operations',
  79.99, 799.99, 'USD', true, true, 50, 50, 100000, 51200,
  '{"max_users":50,"max_brands":50,"max_email_accounts":50,"max_sms_connections":10,"max_whatsapp_connections":10,"max_sender_identities":100,"max_contacts":100000,"max_templates":500,"monthly_email_sends":150000,"monthly_sms_sends":50000,"monthly_whatsapp_sends":50000,"storage_bytes":53687091200}'::jsonb,
  '{"automation":true,"unified_inbox":true,"deliverability":true,"advanced_analytics":true,"white_label":true,"api_webhooks":true,"priority_support":true}'::jsonb
),
(
  'enterprise', 'ENTERPRISE', 'Enterprise', 'Large organizations',
  199.99, 1999.99, 'USD', true, true, 999, 999, 999999, 102400,
  '{"max_users":null,"max_brands":null,"max_email_accounts":null,"max_sms_connections":null,"max_whatsapp_connections":null,"max_sender_identities":null,"max_contacts":null,"max_templates":null,"monthly_email_sends":null,"monthly_sms_sends":null,"monthly_whatsapp_sends":null,"storage_bytes":null}'::jsonb,
  '{"automation":true,"unified_inbox":true,"deliverability":true,"advanced_analytics":true,"white_label":true,"api_webhooks":true,"priority_support":true}'::jsonb
),
(
  'custom', 'CUSTOM', 'Custom', 'Negotiated custom plan',
  0, 0, 'USD', true, false, 999, 999, 999999, 102400,
  '{"max_users":null,"max_brands":null,"max_email_accounts":null,"max_sms_connections":null,"max_whatsapp_connections":null,"max_sender_identities":null,"max_contacts":null,"max_templates":null,"monthly_email_sends":null,"monthly_sms_sends":null,"monthly_whatsapp_sends":null,"storage_bytes":null}'::jsonb,
  '{"automation":true,"unified_inbox":true,"deliverability":true,"advanced_analytics":true,"white_label":true,"api_webhooks":true,"priority_support":true}'::jsonb
);

-- Safe NULL-only backfill: never overwrite super_admin-edited plan values
UPDATE plans p
SET
  code = COALESCE(NULLIF(TRIM(p.code), ''), s.code),
  display_name = COALESCE(NULLIF(TRIM(p.display_name), ''), s.display_name),
  description = COALESCE(p.description, s.description),
  price_monthly = COALESCE(p.price_monthly, s.price_monthly),
  price_yearly = COALESCE(p.price_yearly, s.price_yearly),
  monthly_price = COALESCE(p.monthly_price, p.price_monthly, s.price_monthly),
  yearly_price = COALESCE(p.yearly_price, p.price_yearly, s.price_yearly),
  currency = COALESCE(NULLIF(TRIM(p.currency), ''), s.currency),
  is_active = COALESCE(p.is_active, s.is_active),
  is_public = COALESCE(p.is_public, s.is_public),
  max_accounts = COALESCE(p.max_accounts, s.max_accounts),
  max_users = COALESCE(p.max_users, s.max_users),
  max_daily_fetch = COALESCE(p.max_daily_fetch, s.max_daily_fetch),
  max_storage_mb = COALESCE(p.max_storage_mb, s.max_storage_mb),
  limits = COALESCE(p.limits, s.limits),
  features = COALESCE(p.features, s.features)
FROM _plan_seed s
WHERE UPPER(COALESCE(p.code, '')) = s.code
   OR LOWER(p.name) = s.name
   OR (s.code = 'PROFESSIONAL' AND LOWER(p.name) = 'pro')
   OR (s.code = 'ENTERPRISE' AND LOWER(p.name) = 'enterprise')
   OR (s.code = 'STARTER' AND LOWER(p.name) = 'starter');

-- Insert catalog plans only when the code does not already exist
INSERT INTO plans (
  name, code, display_name, description, price_monthly, price_yearly,
  monthly_price, yearly_price, currency, is_active, is_public,
  max_accounts, max_users, max_daily_fetch, max_storage_mb, limits, features
)
SELECT
  s.name, s.code, s.display_name, s.description, s.price_monthly, s.price_yearly,
  s.price_monthly, s.price_yearly, s.currency, s.is_active, s.is_public,
  s.max_accounts, s.max_users, s.max_daily_fetch, s.max_storage_mb, s.limits, s.features
FROM _plan_seed s
WHERE NOT EXISTS (
  SELECT 1 FROM plans p
  WHERE UPPER(COALESCE(p.code, '')) = s.code
     OR LOWER(p.name) = s.name
     OR (s.code = 'PROFESSIONAL' AND LOWER(p.name) = 'pro')
);

DROP TABLE IF EXISTS _plan_seed;

-- Extend subscriptions
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS billing_period VARCHAR(20) DEFAULT 'MONTHLY';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMP;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider VARCHAR(50) DEFAULT 'manual';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider_customer_id VARCHAR(255);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider_subscription_id VARCHAR(255);

UPDATE subscriptions
SET provider_customer_id = COALESCE(provider_customer_id, stripe_customer_id),
    provider_subscription_id = COALESCE(provider_subscription_id, stripe_subscription_id),
    trial_ends_at = COALESCE(trial_ends_at, trial_end),
    provider = COALESCE(NULLIF(provider, ''), CASE WHEN stripe_subscription_id IS NOT NULL THEN 'stripe' ELSE 'manual' END);

-- Expand subscription status values (keep legacy rows mapped)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_status_check') THEN
    ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_status_check;
  END IF;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;

UPDATE subscriptions SET status = UPPER(status);
UPDATE subscriptions SET status = 'CANCELLED' WHERE status IN ('CANCELED', 'canceled', 'cancelled');
UPDATE subscriptions SET status = 'TRIAL' WHERE status IN ('TRIALING', 'trialing');
UPDATE subscriptions SET status = 'ACTIVE' WHERE status IN ('ACTIVE', 'active');
UPDATE subscriptions SET status = 'PAST_DUE' WHERE status IN ('PAST_DUE', 'past_due');

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_status_check
  CHECK (status IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'SUSPENDED', 'EXPIRED'));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_billing_period_check') THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_billing_period_check
      CHECK (billing_period IN ('MONTHLY', 'YEARLY', 'MANUAL', 'INTERNAL'));
  END IF;
END $$;

-- Per-tenant limit overrides (null keys inherit plan)
CREATE TABLE IF NOT EXISTS tenant_limit_overrides (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  features JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Monthly / count usage snapshot
CREATE TABLE IF NOT EXISTS tenant_usage (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_key VARCHAR(20) NOT NULL,
  email_sent INTEGER NOT NULL DEFAULT 0,
  sms_sent INTEGER NOT NULL DEFAULT 0,
  whatsapp_sent INTEGER NOT NULL DEFAULT 0,
  contacts_count INTEGER NOT NULL DEFAULT 0,
  users_count INTEGER NOT NULL DEFAULT 0,
  brands_count INTEGER NOT NULL DEFAULT 0,
  email_accounts_count INTEGER NOT NULL DEFAULT 0,
  sms_connections_count INTEGER NOT NULL DEFAULT 0,
  whatsapp_connections_count INTEGER NOT NULL DEFAULT 0,
  templates_count INTEGER NOT NULL DEFAULT 0,
  storage_used_bytes BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, period_key)
);

CREATE INDEX IF NOT EXISTS idx_tenant_usage_tenant_period
  ON tenant_usage(tenant_id, period_key);

-- Mark outbound messages that already reserved quota (idempotent retries)
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS usage_reserved BOOLEAN DEFAULT false;

-- Platform audit
CREATE TABLE IF NOT EXISTS platform_audit_logs (
  id SERIAL PRIMARY KEY,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id INTEGER,
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
  before_data JSONB,
  after_data JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_platform_audit_created
  ON platform_audit_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_audit_tenant
  ON platform_audit_logs(tenant_id, created_at DESC);

-- Ensure every tenant has a subscription (STARTER trial) if missing
INSERT INTO subscriptions (
  tenant_id, plan_id, status, billing_period, provider,
  current_period_start, current_period_end, trial_ends_at, cancel_at_period_end
)
SELECT
  t.id,
  p.id,
  'TRIAL',
  'MONTHLY',
  'manual',
  date_trunc('month', CURRENT_TIMESTAMP),
  date_trunc('month', CURRENT_TIMESTAMP) + INTERVAL '1 month',
  CURRENT_TIMESTAMP + INTERVAL '14 days',
  false
FROM tenants t
CROSS JOIN LATERAL (
  SELECT id FROM plans WHERE code = 'STARTER' OR name = 'starter' ORDER BY id LIMIT 1
) p
WHERE NOT EXISTS (
  SELECT 1 FROM subscriptions s WHERE s.tenant_id = t.id
);

UPDATE tenants t
SET subscription_plan = COALESCE(
  (SELECT LOWER(p.code) FROM subscriptions s
   JOIN plans p ON p.id = s.plan_id
   WHERE s.tenant_id = t.id
   ORDER BY s.created_at DESC LIMIT 1),
  t.subscription_plan
);
