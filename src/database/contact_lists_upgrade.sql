-- Static contact lists (tenant-scoped membership, contacts are not duplicated)

CREATE TABLE IF NOT EXISTS contact_lists (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  member_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_lists_tenant_name
  ON contact_lists(tenant_id, lower(name));

CREATE INDEX IF NOT EXISTS idx_contact_lists_tenant_active
  ON contact_lists(tenant_id, is_active);

CREATE TABLE IF NOT EXISTS contact_list_members (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  list_id INTEGER NOT NULL REFERENCES contact_lists(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, list_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_list_members_list
  ON contact_list_members(list_id, contact_id);

CREATE INDEX IF NOT EXISTS idx_contact_list_members_contact
  ON contact_list_members(tenant_id, contact_id);

CREATE TABLE IF NOT EXISTS contact_list_imports (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  list_id INTEGER NOT NULL REFERENCES contact_lists(id) ON DELETE CASCADE,
  filename VARCHAR(500),
  status VARCHAR(20) NOT NULL DEFAULT 'PREVIEW'
    CHECK (status IN ('PREVIEW', 'APPLIED', 'CANCELLED')),
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contact_list_import_rows (
  id SERIAL PRIMARY KEY,
  import_id INTEGER NOT NULL REFERENCES contact_list_imports(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(40) NOT NULL DEFAULT 'PENDING',
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_contact_list_import_rows_import
  ON contact_list_import_rows(import_id, status);
