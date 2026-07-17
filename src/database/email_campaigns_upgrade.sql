-- Email campaign management (idempotent, non-destructive)

CREATE TABLE IF NOT EXISTS campaigns (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  subject VARCHAR(500),
  preheader VARCHAR(500),
  template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
  sender_account_id INTEGER REFERENCES mail_accounts(id) ON DELETE SET NULL,
  sender_identity_id INTEGER REFERENCES sender_identities(id) ON DELETE SET NULL,
  reply_to VARCHAR(320),
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'SCHEDULED', 'QUEUED', 'SENDING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED')),
  audience_config JSONB DEFAULT '{}'::jsonb,
  scheduled_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  timezone VARCHAR(64) DEFAULT 'UTC',
  recipient_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_campaigns_tenant_status ON campaigns(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_campaigns_scheduled ON campaigns(status, scheduled_at)
  WHERE status = 'SCHEDULED';
CREATE INDEX IF NOT EXISTS idx_campaigns_brand ON campaigns(tenant_id, brand_id);

CREATE TABLE IF NOT EXISTS campaign_recipients (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  email VARCHAR(320) NOT NULL,
  email_normalized VARCHAR(320) NOT NULL,
  display_name VARCHAR(255),
  personalisation_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'QUEUED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED', 'SKIPPED')),
  outbound_message_id INTEGER REFERENCES outbound_messages(id) ON DELETE SET NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  queued_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_recipients_email
  ON campaign_recipients(campaign_id, email_normalized);

CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign_status
  ON campaign_recipients(campaign_id, status);

CREATE INDEX IF NOT EXISTS idx_campaign_recipients_outbound
  ON campaign_recipients(outbound_message_id)
  WHERE outbound_message_id IS NOT NULL;

-- Contact tags for audience selection by tag
CREATE TABLE IF NOT EXISTS contact_tag_links (
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, contact_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_tag_links_tag
  ON contact_tag_links(tenant_id, tag_id);

ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL;
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS campaign_recipient_id INTEGER REFERENCES campaign_recipients(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_outbound_messages_campaign
  ON outbound_messages(tenant_id, campaign_id)
  WHERE campaign_id IS NOT NULL;
