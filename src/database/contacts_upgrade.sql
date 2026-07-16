-- Contacts & communication preferences (idempotent, non-destructive)

CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  first_name VARCHAR(120),
  last_name VARCHAR(120),
  company_name VARCHAR(255),
  title VARCHAR(255),
  notes TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'ARCHIVED', 'BLOCKED')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_contacts_tenant_id ON contacts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_name ON contacts(tenant_id, last_name, first_name);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(tenant_id, company_name);

CREATE TABLE IF NOT EXISTS contact_points (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel_type VARCHAR(20) NOT NULL CHECK (channel_type IN ('EMAIL', 'SMS', 'WHATSAPP')),
  value VARCHAR(320) NOT NULL,
  normalized_value VARCHAR(320) NOT NULL,
  label VARCHAR(100),
  is_primary BOOLEAN NOT NULL DEFAULT false,
  is_verified BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_points_tenant_channel_normalized
  ON contact_points(tenant_id, channel_type, normalized_value);

CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_points_primary_per_channel
  ON contact_points(contact_id, channel_type)
  WHERE is_primary = true AND is_active = true;

CREATE INDEX IF NOT EXISTS idx_contact_points_contact_id ON contact_points(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_points_normalized ON contact_points(tenant_id, normalized_value);

CREATE TABLE IF NOT EXISTS contact_brand_links (
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, contact_id, brand_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_brand_links_brand ON contact_brand_links(tenant_id, brand_id);

CREATE TABLE IF NOT EXISTS communication_preferences (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  brand_id INTEGER REFERENCES brands(id) ON DELETE CASCADE,
  channel_type VARCHAR(20) NOT NULL CHECK (channel_type IN ('EMAIL', 'SMS', 'WHATSAPP')),
  status VARCHAR(20) NOT NULL DEFAULT 'UNKNOWN'
    CHECK (status IN ('UNKNOWN', 'OPTED_IN', 'OPTED_OUT', 'BLOCKED')),
  source VARCHAR(100),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_communication_preferences_scope
  ON communication_preferences(tenant_id, contact_id, COALESCE(brand_id, 0), channel_type);

CREATE INDEX IF NOT EXISTS idx_communication_preferences_contact
  ON communication_preferences(tenant_id, contact_id);

CREATE TABLE IF NOT EXISTS consent_events (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
  channel_type VARCHAR(20) NOT NULL CHECK (channel_type IN ('EMAIL', 'SMS', 'WHATSAPP')),
  previous_status VARCHAR(20),
  new_status VARCHAR(20) NOT NULL,
  source VARCHAR(100),
  note TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_consent_events_contact ON consent_events(tenant_id, contact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS contact_events (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,
  note TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_contact_events_contact ON contact_events(tenant_id, contact_id, created_at DESC);
