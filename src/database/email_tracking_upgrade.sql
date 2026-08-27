-- Email campaign tracking & analytics (opens, clicks, downloads, site events, delivery)

CREATE TABLE IF NOT EXISTS campaign_tracking_settings (
  campaign_id INTEGER PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  track_opens BOOLEAN NOT NULL DEFAULT true,
  track_clicks BOOLEAN NOT NULL DEFAULT true,
  track_site BOOLEAN NOT NULL DEFAULT false,
  utm_source VARCHAR(100),
  utm_medium VARCHAR(100),
  utm_campaign VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_campaign_tracking_settings_tenant
  ON campaign_tracking_settings(tenant_id);

CREATE TABLE IF NOT EXISTS campaign_tracked_links (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  link_key VARCHAR(64) NOT NULL,
  label VARCHAR(255),
  destination_url TEXT NOT NULL,
  destination_hash VARCHAR(64) NOT NULL,
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (campaign_id, link_key)
);

CREATE INDEX IF NOT EXISTS idx_campaign_tracked_links_campaign
  ON campaign_tracked_links(campaign_id);

CREATE TABLE IF NOT EXISTS campaign_tracked_files (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  file_name VARCHAR(500) NOT NULL,
  storage_key VARCHAR(500) NOT NULL,
  content_type VARCHAR(120),
  file_size_bytes BIGINT,
  attachment_mode VARCHAR(20) NOT NULL DEFAULT 'TRACKED_LINK'
    CHECK (attachment_mode IN ('TRACKED_LINK', 'MIME_ATTACHMENT')),
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_campaign_tracked_files_campaign
  ON campaign_tracked_files(campaign_id, is_active);

CREATE TABLE IF NOT EXISTS email_tracking_keys (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  campaign_recipient_id INTEGER NOT NULL REFERENCES campaign_recipients(id) ON DELETE CASCADE,
  outbound_message_id INTEGER REFERENCES outbound_messages(id) ON DELETE SET NULL,
  purpose VARCHAR(20) NOT NULL CHECK (purpose IN ('OPEN', 'CLICK', 'DOWNLOAD', 'SITE')),
  purpose_ref_id INTEGER,
  token_hash VARCHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (token_hash)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_email_tracking_keys_recipient_purpose
  ON email_tracking_keys(campaign_recipient_id, purpose, COALESCE(purpose_ref_id, 0));

CREATE INDEX IF NOT EXISTS idx_email_tracking_keys_recipient
  ON email_tracking_keys(campaign_recipient_id, purpose);

CREATE TABLE IF NOT EXISTS email_tracking_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  campaign_recipient_id INTEGER REFERENCES campaign_recipients(id) ON DELETE SET NULL,
  outbound_message_id INTEGER REFERENCES outbound_messages(id) ON DELETE SET NULL,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  event_type VARCHAR(40) NOT NULL,
  event_key VARCHAR(160) NOT NULL,
  link_id INTEGER REFERENCES campaign_tracked_links(id) ON DELETE SET NULL,
  file_id INTEGER REFERENCES campaign_tracked_files(id) ON DELETE SET NULL,
  classification VARCHAR(30),
  device_class VARCHAR(30),
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, event_key)
);

CREATE INDEX IF NOT EXISTS idx_email_tracking_events_campaign
  ON email_tracking_events(campaign_id, event_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_tracking_events_recipient
  ON email_tracking_events(campaign_recipient_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS email_recipient_engagement (
  campaign_recipient_id INTEGER PRIMARY KEY REFERENCES campaign_recipients(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  delivery_status VARCHAR(40),
  queued_at TIMESTAMPTZ,
  send_attempted_at TIMESTAMPTZ,
  smtp_accepted_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  temp_failure_at TIMESTAMPTZ,
  perm_failure_at TIMESTAMPTZ,
  first_open_at TIMESTAMPTZ,
  last_open_at TIMESTAMPTZ,
  open_count INTEGER NOT NULL DEFAULT 0,
  human_open_count INTEGER NOT NULL DEFAULT 0,
  prefetch_open_count INTEGER NOT NULL DEFAULT 0,
  first_click_at TIMESTAMPTZ,
  last_click_at TIMESTAMPTZ,
  click_count INTEGER NOT NULL DEFAULT 0,
  human_click_count INTEGER NOT NULL DEFAULT 0,
  unique_links_clicked INTEGER NOT NULL DEFAULT 0,
  first_download_at TIMESTAMPTZ,
  last_download_at TIMESTAMPTZ,
  download_count INTEGER NOT NULL DEFAULT 0,
  first_site_visit_at TIMESTAMPTZ,
  last_site_visit_at TIMESTAMPTZ,
  site_visit_count INTEGER NOT NULL DEFAULT 0,
  conversion_at TIMESTAMPTZ,
  conversion_type VARCHAR(80),
  unsubscribed_at TIMESTAMPTZ,
  complained_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_email_recipient_engagement_campaign
  ON email_recipient_engagement(campaign_id);

CREATE TABLE IF NOT EXISTS email_link_click_stats (
  link_id INTEGER PRIMARY KEY REFERENCES campaign_tracked_links(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  first_click_at TIMESTAMPTZ,
  last_click_at TIMESTAMPTZ,
  total_clicks INTEGER NOT NULL DEFAULT 0,
  unique_recipients INTEGER NOT NULL DEFAULT 0,
  human_clicks INTEGER NOT NULL DEFAULT 0,
  bot_clicks INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
