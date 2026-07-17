-- Template email media assets (logos, images) stored in object storage
CREATE TABLE IF NOT EXISTS template_media_assets (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
  storage_key TEXT NOT NULL,
  public_url TEXT NOT NULL,
  original_filename TEXT,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_template_media_assets_tenant
  ON template_media_assets(tenant_id);

CREATE INDEX IF NOT EXISTS idx_template_media_assets_brand
  ON template_media_assets(brand_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_template_media_assets_storage_key
  ON template_media_assets(storage_key);
