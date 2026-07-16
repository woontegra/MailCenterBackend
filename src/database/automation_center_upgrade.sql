-- Automation Center upgrade (idempotent, non-destructive)

-- Extend automation_rules
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL;
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS trigger_type VARCHAR(60);
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS trigger_config JSONB DEFAULT '{}'::jsonb;
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS status VARCHAR(20);
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS execution_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS last_executed_at TIMESTAMP;

-- Migrate legacy is_active → status
UPDATE automation_rules
SET status = CASE
  WHEN COALESCE(is_active, true) = true THEN 'ACTIVE'
  ELSE 'PAUSED'
END
WHERE status IS NULL;

UPDATE automation_rules
SET trigger_type = COALESCE(NULLIF(trigger_type, ''), 'INBOUND_EMAIL_RECEIVED')
WHERE trigger_type IS NULL OR trigger_type = '';

UPDATE automation_rules
SET conditions = COALESCE(conditions, '[]'::jsonb),
    actions = COALESCE(actions, '[]'::jsonb);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_rules_status_check') THEN
    ALTER TABLE automation_rules DROP CONSTRAINT automation_rules_status_check;
  END IF;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE automation_rules DROP CONSTRAINT IF EXISTS automation_rules_status_check;
ALTER TABLE automation_rules
  ADD CONSTRAINT automation_rules_status_check
  CHECK (status IN ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_rules_trigger_type_check') THEN
    ALTER TABLE automation_rules DROP CONSTRAINT automation_rules_trigger_type_check;
  END IF;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE automation_rules DROP CONSTRAINT IF EXISTS automation_rules_trigger_type_check;
ALTER TABLE automation_rules
  ADD CONSTRAINT automation_rules_trigger_type_check
  CHECK (trigger_type IN (
    'CONTACT_CREATED',
    'CONTACT_UPDATED',
    'INBOUND_EMAIL_RECEIVED',
    'INBOUND_WHATSAPP_RECEIVED',
    'CONVERSATION_CREATED',
    'CONVERSATION_STATUS_CHANGED',
    'OUTBOUND_MESSAGE_FAILED',
    'MANUAL'
  ));

CREATE INDEX IF NOT EXISTS idx_automation_rules_tenant_status
  ON automation_rules(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_automation_rules_tenant_trigger
  ON automation_rules(tenant_id, trigger_type, status);

-- Ordered actions (replaces nested actions JSON for new rules; legacy JSON kept for read)
CREATE TABLE IF NOT EXISTS automation_actions (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  automation_rule_id INTEGER NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  action_type VARCHAR(60) NOT NULL,
  action_order INTEGER NOT NULL DEFAULT 0,
  delay_seconds INTEGER NOT NULL DEFAULT 0,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_actions_type_check') THEN
    ALTER TABLE automation_actions
      ADD CONSTRAINT automation_actions_type_check
      CHECK (action_type IN (
        'SEND_EMAIL',
        'SEND_SMS',
        'SEND_WHATSAPP',
        'ASSIGN_CONVERSATION',
        'SET_CONVERSATION_STATUS',
        'SET_CONVERSATION_PRIORITY',
        'CREATE_INTERNAL_NOTE',
        'ADD_CONTACT_BRAND',
        'UPDATE_COMMUNICATION_PREFERENCE'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_automation_actions_rule
  ON automation_actions(automation_rule_id, action_order);

-- Migrate legacy JSONB actions into automation_actions once
INSERT INTO automation_actions (
  tenant_id, automation_rule_id, action_type, action_order, delay_seconds, config, is_active
)
SELECT
  r.tenant_id,
  r.id,
  CASE LOWER(COALESCE(a.elem->>'type', ''))
    WHEN 'add_tag' THEN 'CREATE_INTERNAL_NOTE'
    WHEN 'mark_read' THEN 'SET_CONVERSATION_STATUS'
    WHEN 'star' THEN 'SET_CONVERSATION_PRIORITY'
    WHEN 'assign' THEN 'ASSIGN_CONVERSATION'
    WHEN 'set_status' THEN 'SET_CONVERSATION_STATUS'
    WHEN 'send_email' THEN 'SEND_EMAIL'
    WHEN 'send_sms' THEN 'SEND_SMS'
    WHEN 'send_whatsapp' THEN 'SEND_WHATSAPP'
    ELSE 'CREATE_INTERNAL_NOTE'
  END,
  (a.ord - 1)::int,
  0,
  jsonb_build_object(
    'legacy', true,
    'legacyType', a.elem->>'type',
    'value', a.elem->'value',
    'note', CASE
      WHEN LOWER(COALESCE(a.elem->>'type','')) = 'add_tag'
        THEN 'Legacy etiket aksiyonu: ' || COALESCE(a.elem->>'value', '')
      ELSE COALESCE(a.elem->>'value', 'Legacy otomasyon aksiyonu')
    END,
    'status', CASE WHEN LOWER(COALESCE(a.elem->>'type','')) IN ('mark_read','set_status')
      THEN COALESCE(a.elem->>'value', 'OPEN') ELSE NULL END,
    'priority', CASE WHEN LOWER(COALESCE(a.elem->>'type','')) = 'star' THEN 'HIGH' ELSE NULL END,
    'assignedUserId', CASE WHEN LOWER(COALESCE(a.elem->>'type','')) = 'assign'
      THEN a.elem->'value' ELSE NULL END
  ),
  true
FROM automation_rules r
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.actions, '[]'::jsonb)) WITH ORDINALITY AS a(elem, ord)
WHERE NOT EXISTS (
  SELECT 1 FROM automation_actions x WHERE x.automation_rule_id = r.id
)
AND jsonb_typeof(COALESCE(r.actions, '[]'::jsonb)) = 'array'
AND jsonb_array_length(COALESCE(r.actions, '[]'::jsonb)) > 0;

CREATE TABLE IF NOT EXISTS automation_executions (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  automation_rule_id INTEGER NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  trigger_type VARCHAR(60) NOT NULL,
  trigger_event_id VARCHAR(191) NOT NULL,
  trigger_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  matched_conditions JSONB,
  action_count INTEGER NOT NULL DEFAULT 0,
  completed_action_count INTEGER NOT NULL DEFAULT 0,
  skipped_action_count INTEGER NOT NULL DEFAULT 0,
  safe_error_message TEXT,
  chain_depth INTEGER NOT NULL DEFAULT 0,
  origin_automation_id INTEGER,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_executions_status_check') THEN
    ALTER TABLE automation_executions
      ADD CONSTRAINT automation_executions_status_check
      CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_exec_rule_event
  ON automation_executions(automation_rule_id, trigger_event_id);

CREATE INDEX IF NOT EXISTS idx_automation_exec_tenant_created
  ON automation_executions(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_automation_exec_rule
  ON automation_executions(automation_rule_id, created_at DESC);

CREATE TABLE IF NOT EXISTS automation_action_executions (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  automation_execution_id INTEGER NOT NULL REFERENCES automation_executions(id) ON DELETE CASCADE,
  automation_action_id INTEGER REFERENCES automation_actions(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  outbound_message_id INTEGER REFERENCES outbound_messages(id) ON DELETE SET NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  safe_error_message TEXT,
  result_meta JSONB DEFAULT '{}'::jsonb,
  scheduled_at TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_action_exec_status_check') THEN
    ALTER TABLE automation_action_executions
      ADD CONSTRAINT automation_action_exec_status_check
      CHECK (status IN ('PENDING', 'SCHEDULED', 'PROCESSING', 'COMPLETED', 'SKIPPED', 'FAILED', 'CANCELLED'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_automation_action_exec_parent
  ON automation_action_executions(automation_execution_id, id);
