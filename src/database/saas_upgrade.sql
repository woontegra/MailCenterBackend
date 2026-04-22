-- SaaS Production Upgrade

-- 1. PLANS TABLE
CREATE TABLE IF NOT EXISTS plans (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  display_name VARCHAR(100) NOT NULL,
  price_monthly DECIMAL(10,2) NOT NULL,
  price_yearly DECIMAL(10,2) NOT NULL,
  max_accounts INTEGER NOT NULL,
  max_users INTEGER NOT NULL,
  max_daily_fetch INTEGER NOT NULL,
  max_storage_mb INTEGER NOT NULL,
  features JSONB DEFAULT '[]',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO plans (name, display_name, price_monthly, price_yearly, max_accounts, max_users, max_daily_fetch, max_storage_mb, features) VALUES
('starter', 'Starter', 9.99, 99.99, 3, 2, 1000, 1024, '["Basic support", "Email sync", "Basic automation"]'),
('pro', 'Pro', 29.99, 299.99, 10, 10, 10000, 10240, '["Priority support", "Advanced automation", "API access", "Custom templates"]'),
('enterprise', 'Enterprise', 99.99, 999.99, 999, 999, 999999, 102400, '["24/7 support", "Unlimited automation", "White label", "Custom integrations", "SLA"]')
ON CONFLICT (name) DO NOTHING;

-- 2. SUBSCRIPTIONS TABLE
CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  stripe_subscription_id VARCHAR(255) UNIQUE,
  stripe_customer_id VARCHAR(255),
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'canceled', 'past_due', 'trialing')),
  current_period_start TIMESTAMP,
  current_period_end TIMESTAMP,
  cancel_at_period_end BOOLEAN DEFAULT false,
  trial_end TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. USAGE LIMITS TABLE
CREATE TABLE IF NOT EXISTS usage_limits (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_start TIMESTAMP NOT NULL,
  period_end TIMESTAMP NOT NULL,
  accounts_used INTEGER DEFAULT 0,
  users_used INTEGER DEFAULT 0,
  mails_fetched INTEGER DEFAULT 0,
  mails_sent INTEGER DEFAULT 0,
  storage_used_mb INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, period_start)
);

-- 4. USAGE LOGS TABLE
CREATE TABLE IF NOT EXISTS usage_logs (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action_type VARCHAR(50) NOT NULL,
  resource_type VARCHAR(50),
  resource_id INTEGER,
  quantity INTEGER DEFAULT 1,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. ERROR LOGS TABLE
CREATE TABLE IF NOT EXISTS error_logs (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  error_type VARCHAR(100) NOT NULL,
  error_message TEXT NOT NULL,
  stack_trace TEXT,
  request_url TEXT,
  request_method VARCHAR(10),
  request_body JSONB,
  ip_address VARCHAR(45),
  user_agent TEXT,
  severity VARCHAR(20) DEFAULT 'error' CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  resolved BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 6. PAYMENT TRANSACTIONS TABLE
CREATE TABLE IF NOT EXISTS payment_transactions (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
  stripe_payment_id VARCHAR(255) UNIQUE,
  amount DECIMAL(10,2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'USD',
  status VARCHAR(20) NOT NULL,
  payment_method VARCHAR(50),
  metadata JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. EXTEND MAIL_ACCOUNTS FOR SYNC OPTIMIZATION
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS last_sync_uid INTEGER DEFAULT 0;
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMP;
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS sync_status VARCHAR(20) DEFAULT 'idle' CHECK (sync_status IN ('idle', 'syncing', 'error'));
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS sync_error TEXT;

-- 8. EXTEND USERS FOR SUPER ADMIN
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('super_admin', 'admin', 'member'));

-- 9. INDEXES FOR PERFORMANCE
CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant_id ON subscriptions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_subscription_id ON subscriptions(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_usage_limits_tenant_id ON usage_limits(tenant_id);
CREATE INDEX IF NOT EXISTS idx_usage_limits_period ON usage_limits(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_usage_logs_tenant_id ON usage_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_created_at ON usage_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_logs_action_type ON usage_logs(action_type);
CREATE INDEX IF NOT EXISTS idx_error_logs_tenant_id ON error_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_error_logs_severity ON error_logs(severity);
CREATE INDEX IF NOT EXISTS idx_error_logs_created_at ON error_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_logs_resolved ON error_logs(resolved);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_tenant_id ON payment_transactions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_subscription_id ON payment_transactions(subscription_id);
CREATE INDEX IF NOT EXISTS idx_mail_accounts_last_sync_at ON mail_accounts(last_sync_at);
CREATE INDEX IF NOT EXISTS idx_mail_accounts_sync_status ON mail_accounts(sync_status);

-- 10. PERFORMANCE INDEXES ON EXISTING TABLES
CREATE INDEX IF NOT EXISTS idx_mails_tenant_date ON mails(tenant_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_mails_account_date ON mails(account_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_tags_tenant_name ON tags(tenant_id, name);
CREATE INDEX IF NOT EXISTS idx_mail_tags_mail_id ON mail_tags(mail_id);
CREATE INDEX IF NOT EXISTS idx_mail_tags_tag_id ON mail_tags(tag_id);
