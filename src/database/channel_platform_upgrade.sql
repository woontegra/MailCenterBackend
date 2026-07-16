-- Channel platform foundation (brands, connections, sender identities, template extensions)
-- Idempotent, non-destructive upgrade for multi-channel SaaS readiness

-- 1. BRANDS
CREATE TABLE IF NOT EXISTS brands (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) NOT NULL,
  domain VARCHAR(255),
  logo_url TEXT,
  accent_color VARCHAR(32),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_brands_tenant_slug
  ON brands(tenant_id, slug);

CREATE UNIQUE INDEX IF NOT EXISTS uq_brands_tenant_domain
  ON brands(tenant_id, domain)
  WHERE domain IS NOT NULL AND domain <> '';

CREATE INDEX IF NOT EXISTS idx_brands_tenant_id ON brands(tenant_id);
CREATE INDEX IF NOT EXISTS idx_brands_is_active ON brands(is_active);

-- 2. CHANNEL CONNECTIONS
CREATE TABLE IF NOT EXISTS channel_connections (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE RESTRICT,
  channel_type VARCHAR(20) NOT NULL CHECK (channel_type IN ('EMAIL', 'SMS', 'WHATSAPP')),
  provider VARCHAR(100),
  display_name VARCHAR(255) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'NOT_CONFIGURED'
    CHECK (status IN ('NOT_CONFIGURED', 'ACTIVE', 'DISABLED', 'ERROR')),
  encrypted_credentials TEXT,
  mail_account_id INTEGER REFERENCES mail_accounts(id) ON DELETE SET NULL,
  settings JSONB DEFAULT '{}'::jsonb,
  last_tested_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_channel_connections_tenant_id ON channel_connections(tenant_id);
CREATE INDEX IF NOT EXISTS idx_channel_connections_brand_id ON channel_connections(brand_id);
CREATE INDEX IF NOT EXISTS idx_channel_connections_channel_type ON channel_connections(channel_type);
CREATE INDEX IF NOT EXISTS idx_channel_connections_mail_account_id ON channel_connections(mail_account_id);
CREATE INDEX IF NOT EXISTS idx_channel_connections_status ON channel_connections(status);

CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_connections_brand_type_name
  ON channel_connections(tenant_id, brand_id, channel_type, display_name);

-- 3. SENDER IDENTITIES
CREATE TABLE IF NOT EXISTS sender_identities (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE RESTRICT,
  channel_connection_id INTEGER NOT NULL REFERENCES channel_connections(id) ON DELETE RESTRICT,
  channel_type VARCHAR(20) NOT NULL CHECK (channel_type IN ('EMAIL', 'SMS', 'WHATSAPP')),
  display_name VARCHAR(255) NOT NULL,
  sender_value VARCHAR(320) NOT NULL,
  reply_to VARCHAR(320),
  is_default BOOLEAN DEFAULT false,
  is_verified BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sender_identities_tenant_id ON sender_identities(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sender_identities_brand_id ON sender_identities(brand_id);
CREATE INDEX IF NOT EXISTS idx_sender_identities_connection_id ON sender_identities(channel_connection_id);
CREATE INDEX IF NOT EXISTS idx_sender_identities_channel_type ON sender_identities(channel_type);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sender_identities_connection_value
  ON sender_identities(tenant_id, channel_connection_id, sender_value);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sender_identities_default_per_brand_channel
  ON sender_identities(tenant_id, brand_id, channel_type)
  WHERE is_default = true;

-- 4. EXTEND EXISTING TEMPLATES (no second table)
ALTER TABLE templates ADD COLUMN IF NOT EXISTS brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS channel_type VARCHAR(20);
ALTER TABLE templates ADD COLUMN IF NOT EXISTS sender_identity_id INTEGER REFERENCES sender_identities(id) ON DELETE SET NULL;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS subject TEXT;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS plain_text_content TEXT;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS variables JSONB DEFAULT '[]'::jsonb;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'templates_channel_type_check'
  ) THEN
    ALTER TABLE templates
      ADD CONSTRAINT templates_channel_type_check
      CHECK (channel_type IS NULL OR channel_type IN ('EMAIL', 'SMS', 'WHATSAPP'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_templates_brand_id ON templates(brand_id);
CREATE INDEX IF NOT EXISTS idx_templates_channel_type ON templates(channel_type);
CREATE INDEX IF NOT EXISTS idx_templates_sender_identity_id ON templates(sender_identity_id);
CREATE INDEX IF NOT EXISTS idx_templates_is_active ON templates(is_active);
