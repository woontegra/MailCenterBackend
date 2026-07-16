import { query } from '../config/database';
import {
  MAX_ACTIONS_PER_RULE,
  MAX_DELAY_SECONDS,
  isAutomationActionType,
} from './automationConstants';
import { evaluateConditions } from './automationConditionEvaluator';
import {
  enrichPayloadContext,
  executeAutomationAction,
} from './automationActionExecutor';
import { enqueueAutomationAction } from '../queues/automationQueue';
import { assertFeatureEnabled, assertTenantWritable } from './entitlementService';

export async function processAutomationExecution(
  executionId: number,
  tenantId: number
): Promise<void> {
  const execRes = await query(
    `SELECT e.*, r.status AS rule_status, r.conditions, r.created_by AS rule_created_by,
            r.name AS rule_name, r.brand_id AS rule_brand_id
     FROM automation_executions e
     JOIN automation_rules r ON r.id = e.automation_rule_id
     WHERE e.id = $1 AND e.tenant_id = $2`,
    [executionId, tenantId]
  );
  const execution = execRes.rows[0];
  if (!execution) return;
  if (!['PENDING', 'PROCESSING'].includes(execution.status)) return;

  try {
    await assertFeatureEnabled(tenantId, 'automation');
    await assertTenantWritable(tenantId);
  } catch (error: any) {
    await query(
      `UPDATE automation_executions
       SET status = 'CANCELLED',
           safe_error_message = $3,
           completed_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND tenant_id = $2`,
      [executionId, tenantId, String(error?.message || 'Otomasyon çalıştırılamaz').slice(0, 400)]
    );
    return;
  }

  if (execution.rule_status !== 'ACTIVE' && execution.trigger_type !== 'MANUAL') {
    await query(
      `UPDATE automation_executions
       SET status = 'CANCELLED', safe_error_message = 'Kural aktif değil',
           completed_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND tenant_id = $2`,
      [executionId, tenantId]
    );
    return;
  }

  await query(
    `UPDATE automation_executions
     SET status = 'PROCESSING', started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
     WHERE id = $1 AND tenant_id = $2`,
    [executionId, tenantId]
  );

  const payload = await enrichPayloadContext(
    tenantId,
    typeof execution.trigger_payload === 'object' ? execution.trigger_payload : {}
  );

  if (execution.rule_brand_id && payload.brandId &&
      Number(execution.rule_brand_id) !== Number(payload.brandId)) {
    await query(
      `UPDATE automation_executions
       SET status = 'COMPLETED', matched_conditions = '[]'::jsonb,
           safe_error_message = 'Marka eşleşmedi', completed_at = CURRENT_TIMESTAMP,
           action_count = 0
       WHERE id = $1 AND tenant_id = $2`,
      [executionId, tenantId]
    );
    return;
  }

  const evalResult = evaluateConditions(execution.conditions, payload);
  if (!evalResult.matched) {
    await query(
      `UPDATE automation_executions
       SET status = 'COMPLETED',
           matched_conditions = $3::jsonb,
           action_count = 0,
           completed_action_count = 0,
           completed_at = CURRENT_TIMESTAMP,
           safe_error_message = 'Koşullar eşleşmedi'
       WHERE id = $1 AND tenant_id = $2`,
      [executionId, tenantId, JSON.stringify(evalResult.details)]
    );
    return;
  }

  const actions = await query(
    `SELECT * FROM automation_actions
     WHERE automation_rule_id = $1 AND tenant_id = $2 AND COALESCE(is_active, true) = true
     ORDER BY action_order ASC, id ASC
     LIMIT $3`,
    [execution.automation_rule_id, tenantId, MAX_ACTIONS_PER_RULE]
  );

  await query(
    `UPDATE automation_executions
     SET matched_conditions = $3::jsonb, action_count = $4
     WHERE id = $1 AND tenant_id = $2`,
    [executionId, tenantId, JSON.stringify(evalResult.details), actions.rows.length]
  );

  if (actions.rows.length === 0) {
    await finalizeExecution(executionId, tenantId);
    return;
  }

  for (const action of actions.rows) {
    const delay = Math.min(
      MAX_DELAY_SECONDS,
      Math.max(0, Number(action.delay_seconds) || 0)
    );
    const inserted = await query(
      `INSERT INTO automation_action_executions (
         tenant_id, automation_execution_id, automation_action_id,
         status, scheduled_at
       ) VALUES ($1,$2,$3,$4,$5)
       RETURNING id`,
      [
        tenantId,
        executionId,
        action.id,
        delay > 0 ? 'SCHEDULED' : 'PENDING',
        delay > 0 ? new Date(Date.now() + delay * 1000) : null,
      ]
    );
    await enqueueAutomationAction(inserted.rows[0].id, tenantId, delay * 1000);
  }
}

export async function processAutomationActionExecution(
  actionExecutionId: number,
  tenantId: number
): Promise<void> {
  const rowRes = await query(
    `SELECT ae.*, a.action_type, a.config, a.delay_seconds,
            e.automation_rule_id, e.trigger_payload, e.chain_depth, e.status AS exec_status,
            r.created_by AS rule_created_by
     FROM automation_action_executions ae
     JOIN automation_executions e ON e.id = ae.automation_execution_id
     JOIN automation_actions a ON a.id = ae.automation_action_id
     JOIN automation_rules r ON r.id = e.automation_rule_id
     WHERE ae.id = $1 AND ae.tenant_id = $2`,
    [actionExecutionId, tenantId]
  );
  const row = rowRes.rows[0];
  if (!row) return;
  if (['COMPLETED', 'SKIPPED', 'CANCELLED'].includes(row.status)) return;
  if (['CANCELLED', 'FAILED'].includes(row.exec_status)) return;

  try {
    await assertFeatureEnabled(tenantId, 'automation');
    await assertTenantWritable(tenantId);
  } catch (error: any) {
    await query(
      `UPDATE automation_action_executions
       SET status = 'SKIPPED', safe_error_message = $3, completed_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND tenant_id = $2`,
      [actionExecutionId, tenantId, String(error?.message || 'Atlandı').slice(0, 400)]
    );
    await finalizeExecution(row.automation_execution_id, tenantId);
    return;
  }

  await query(
    `UPDATE automation_action_executions
     SET status = 'PROCESSING',
         started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
         attempt_count = attempt_count + 1
     WHERE id = $1 AND tenant_id = $2`,
    [actionExecutionId, tenantId]
  );

  if (!isAutomationActionType(row.action_type)) {
    await query(
      `UPDATE automation_action_executions
       SET status = 'FAILED', safe_error_message = 'Geçersiz aksiyon tipi',
           completed_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND tenant_id = $2`,
      [actionExecutionId, tenantId]
    );
    await finalizeExecution(row.automation_execution_id, tenantId);
    return;
  }

  const payload = await enrichPayloadContext(
    tenantId,
    typeof row.trigger_payload === 'object' ? row.trigger_payload : {}
  );

  const result = await executeAutomationAction({
    tenantId,
    actionType: row.action_type,
    config: row.config || {},
    payload,
    executionId: row.automation_execution_id,
    actionId: row.automation_action_id,
    ruleId: row.automation_rule_id,
    chainDepth: Number(row.chain_depth) || 0,
    createdBy: Number(row.rule_created_by) || 0,
  });

  await query(
    `UPDATE automation_action_executions
     SET status = $3,
         outbound_message_id = $4,
         safe_error_message = $5,
         result_meta = $6::jsonb,
         completed_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND tenant_id = $2`,
    [
      actionExecutionId,
      tenantId,
      result.status,
      result.outboundMessageId || null,
      result.safeError || null,
      JSON.stringify(result.meta || {}),
    ]
  );

  await finalizeExecution(row.automation_execution_id, tenantId);
}

async function finalizeExecution(executionId: number, tenantId: number) {
  const counts = await query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status IN ('PENDING','SCHEDULED','PROCESSING'))::int AS open,
       COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
       COUNT(*) FILTER (WHERE status = 'SKIPPED')::int AS skipped,
       COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed
     FROM automation_action_executions
     WHERE automation_execution_id = $1 AND tenant_id = $2`,
    [executionId, tenantId]
  );
  const c = counts.rows[0];
  if (!c || c.open > 0) return;

  let status: string = 'COMPLETED';
  if (c.failed > 0 && c.completed === 0 && c.skipped === 0) status = 'FAILED';
  else if (c.failed > 0) status = 'PARTIAL';
  else if (c.completed === 0 && c.skipped > 0) status = 'COMPLETED';

  const rule = await query(
    `UPDATE automation_executions
     SET status = $3,
         completed_action_count = $4,
         skipped_action_count = $5,
         completed_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND tenant_id = $2
     RETURNING automation_rule_id`,
    [executionId, tenantId, status, c.completed, c.skipped]
  );

  if (rule.rows[0] && (status === 'COMPLETED' || status === 'PARTIAL')) {
    await query(
      `UPDATE automation_rules
       SET execution_count = COALESCE(execution_count, 0) + 1,
           last_executed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND tenant_id = $2`,
      [rule.rows[0].automation_rule_id, tenantId]
    );
  }
}

/** Simulate conditions + planned actions without side effects */
export async function simulateAutomation(params: {
  tenantId: number;
  ruleId: number;
  samplePayload: Record<string, unknown>;
}) {
  const rule = await query(
    `SELECT * FROM automation_rules WHERE id = $1 AND tenant_id = $2 AND status <> 'ARCHIVED'`,
    [params.ruleId, params.tenantId]
  );
  if (!rule.rows[0]) return null;

  const payload = await enrichPayloadContext(params.tenantId, params.samplePayload as any);
  const evalResult = evaluateConditions(rule.rows[0].conditions, payload);
  const actions = await query(
    `SELECT id, action_type, action_order, delay_seconds, config, is_active
     FROM automation_actions
     WHERE automation_rule_id = $1 AND tenant_id = $2
     ORDER BY action_order ASC, id ASC`,
    [params.ruleId, params.tenantId]
  );

  const planned = actions.rows.map((a: any) => {
    const type = a.action_type;
    let wouldSkip = false;
    let skipReason: string | null = null;
    if (['SEND_SMS', 'SEND_WHATSAPP'].includes(type)) {
      wouldSkip = true;
      skipReason =
        'Test modu: gerçek gönderim yok. Canlı çalıştırmada OPTED_IN ve kota kontrolleri uygulanır.';
    } else if (type === 'SEND_EMAIL') {
      wouldSkip = true;
      skipReason =
        'Test modu: gerçek e-posta oluşturulmaz. Canlı çalıştırmada BLOCKED adresler atlanır.';
    }
    return {
      id: a.id,
      actionType: type,
      actionOrder: a.action_order,
      delaySeconds: a.delay_seconds,
      wouldRun: evalResult.matched && a.is_active !== false && !wouldSkip,
      wouldSkip: !evalResult.matched || wouldSkip,
      skipReason: !evalResult.matched ? 'Koşullar eşleşmedi' : skipReason,
      configKeys: Object.keys(a.config || {}),
    };
  });

  return {
    rule: {
      id: rule.rows[0].id,
      name: rule.rows[0].name,
      triggerType: rule.rows[0].trigger_type,
      status: rule.rows[0].status,
    },
    matched: evalResult.matched,
    conditions: evalResult.details,
    payload,
    actions: planned,
    sendsRealMessages: false,
  };
}

/** @deprecated Legacy mail-only entry — now emits INBOUND_EMAIL_RECEIVED */
export async function applyAutomationRules(mailId: number, tenantId: number) {
  const { emitAutomationEvent } = await import('./automationEmitter');
  const mail = await query(
    `SELECT id, subject, from_address, to_address, body_preview, account_id
     FROM mails WHERE id = $1 AND tenant_id = $2`,
    [mailId, tenantId]
  );
  if (!mail.rows[0]) return;
  const m = mail.rows[0];
  let brandId: number | null = null;
  try {
    const acc = await query(
      `SELECT brand_id FROM mail_accounts WHERE id = $1 AND tenant_id = $2`,
      [m.account_id, tenantId]
    );
    brandId = acc.rows[0]?.brand_id || null;
  } catch {
    /* ignore */
  }
  await emitAutomationEvent({
    tenantId,
    triggerType: 'INBOUND_EMAIL_RECEIVED',
    triggerEventId: `mail:${mailId}`,
    payload: {
      mailId,
      brandId,
      channel: 'EMAIL',
      fromAddress: m.from_address,
      toAddress: m.to_address,
      subject: m.subject,
      messagePreview: m.body_preview,
    },
  });
}
