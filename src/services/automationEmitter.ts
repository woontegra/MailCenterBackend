import { query } from '../config/database';
import {
  AutomationTrigger,
  MAX_CHAIN_DEPTH,
  isAutomationTrigger,
  sanitizePayload,
} from './automationConstants';
import { enqueueAutomationExecution, assertAutomationQueueReady } from '../queues/automationQueue';
import { assertFeatureEnabled, assertTenantWritable } from './entitlementService';

export type EmitAutomationEventInput = {
  tenantId: number;
  triggerType: AutomationTrigger;
  triggerEventId: string;
  payload?: Record<string, unknown>;
  chainDepth?: number;
  originAutomationId?: number | null;
};

/**
 * After a durable DB write, enqueue matching ACTIVE automations.
 * Never throws to callers by default — use emitAutomationEventStrict for API paths.
 */
export async function emitAutomationEvent(input: EmitAutomationEventInput): Promise<void> {
  try {
    await emitAutomationEventStrict(input);
  } catch (error) {
    console.error('emitAutomationEvent error:', (error as Error)?.message || error);
  }
}

export async function emitAutomationEventStrict(input: EmitAutomationEventInput): Promise<{
  enqueued: number;
  skippedReason?: string;
}> {
  if (!isAutomationTrigger(input.triggerType)) {
    return { enqueued: 0, skippedReason: 'invalid_trigger' };
  }

  const chainDepth = Math.max(0, Number(input.chainDepth) || 0);
  if (chainDepth >= MAX_CHAIN_DEPTH) {
    return { enqueued: 0, skippedReason: 'max_chain_depth' };
  }

  try {
    await assertFeatureEnabled(input.tenantId, 'automation');
    await assertTenantWritable(input.tenantId);
  } catch (error: any) {
    return { enqueued: 0, skippedReason: error?.code || 'feature_or_writable' };
  }

  const queueReady = await assertAutomationQueueReady();
  if (!queueReady.ok) {
    // Do not pretend ACTIVE automations run without queue
    return { enqueued: 0, skippedReason: 'queue_unavailable' };
  }

  const eventId = String(input.triggerEventId || '').slice(0, 191);
  if (!eventId) return { enqueued: 0, skippedReason: 'missing_event_id' };

  const payload = sanitizePayload({
    ...(input.payload || {}),
    originAutomationId: input.originAutomationId ?? null,
    chainDepth,
  });

  const rules = await query(
    `SELECT id, brand_id
     FROM automation_rules
     WHERE tenant_id = $1
       AND status = 'ACTIVE'
       AND trigger_type = $2`,
    [input.tenantId, input.triggerType]
  );

  let enqueued = 0;
  for (const rule of rules.rows) {
    if (
      input.originAutomationId &&
      Number(input.originAutomationId) === Number(rule.id)
    ) {
      continue;
    }
    if (payload.brandId && rule.brand_id && Number(rule.brand_id) !== Number(payload.brandId)) {
      continue;
    }

    try {
      const inserted = await query(
        `INSERT INTO automation_executions (
           tenant_id, automation_rule_id, trigger_type, trigger_event_id,
           trigger_payload, status, chain_depth, origin_automation_id
         ) VALUES ($1,$2,$3,$4,$5::jsonb,'PENDING',$6,$7)
         ON CONFLICT (automation_rule_id, trigger_event_id) DO NOTHING
         RETURNING id`,
        [
          input.tenantId,
          rule.id,
          input.triggerType,
          eventId,
          JSON.stringify(payload),
          chainDepth,
          input.originAutomationId || null,
        ]
      );
      if (!inserted.rows[0]) continue;
      await enqueueAutomationExecution(inserted.rows[0].id, input.tenantId);
      enqueued += 1;
    } catch (error) {
      console.error('Failed to enqueue automation execution:', error);
    }
  }

  return { enqueued };
}
