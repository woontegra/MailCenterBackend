-- Allow one WhatsApp channel_connection to be used by multiple brands within the same tenant.
-- Primary owner remains channel_connections.brand_id; additional brands use share rows.

CREATE TABLE IF NOT EXISTS channel_connection_brand_shares (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_connection_id INTEGER NOT NULL REFERENCES channel_connections(id) ON DELETE CASCADE,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_channel_connection_brand_share UNIQUE (tenant_id, channel_connection_id, brand_id)
);

CREATE INDEX IF NOT EXISTS idx_cc_brand_shares_tenant_brand
  ON channel_connection_brand_shares (tenant_id, brand_id);

CREATE INDEX IF NOT EXISTS idx_cc_brand_shares_tenant_connection
  ON channel_connection_brand_shares (tenant_id, channel_connection_id);

COMMENT ON TABLE channel_connection_brand_shares IS
  'Maps additional brands to an existing channel_connection within the same tenant (outbound use).';
