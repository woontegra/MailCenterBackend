import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { query } from '../config/database';
import { requirePermission } from '../permissions/requirePermission';
import { enforceFeature } from '../utils/quotaGuards';
import { badRequest, notFound } from '../utils/channelPlatform';
import {
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_STATUSES,
  MAX_ACTIONS_PER_RULE,
  MAX_DELAY_SECONDS,
  isAutomationActionType,
  isAutomationTrigger,
} from '../services/automationConstants';
import { validateConditionsInput } from '../services/automationConditionEvaluator';
import { simulateAutomation, processAutomationExecution } from '../services/automationEngine';
import { buildManualEventId } from '../services/automationActionExecutor';
import { emitAutomationEventStrict } from '../services/automationEmitter';
import { assertAutomationQueueReady } from '../queues/automationQueue';
import {
  assertTenantWritable,
  respondEntitlementError,
} from '../services/entitlementService';

const router = Router();
router.use(authenticate);

async function ensureFeature(req: AuthRequest, res: Response) {
  return enforceFeature(res, req.user!.tenantId, 'automation');
}

/** Mutation endpoints require a writable (ACTIVE) tenant. */
async function ensureWritable(req: AuthRequest, res: Response) {
  try {
    await assertTenantWritable(req.user!.tenantId);
    return true;
  } catch (error) {
    if (respondEntitlementError(res, error)) return false;
    throw error;
  }
}

function sanitizeRule(row: any, actions?: any[]) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    brandId: row.brand_id,
    name: row.name,
    description: row.description,
    triggerType: row.trigger_type,
    triggerConfig: row.trigger_config || {},
    conditions: row.conditions || [],
    status: row.status,
    executionCount: row.execution_count || 0,
    lastExecutedAt: row.last_executed_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    actions: (actions || []).map(sanitizeAction),
  };
}

function sanitizeAction(a: any) {
  return {
    id: a.id,
    actionType: a.action_type,
    actionOrder: a.action_order,
    delaySeconds: a.delay_seconds,
    config: a.config || {},
    isActive: a.is_active !== false,
  };
}

function sanitizeExecution(row: any) {
  return {
    id: row.id,
    automationRuleId: row.automation_rule_id,
    triggerType: row.trigger_type,
    triggerEventId: row.trigger_event_id,
    triggerPayload: row.trigger_payload,
    status: row.status,
    matchedConditions: row.matched_conditions,
    actionCount: row.action_count,
    completedActionCount: row.completed_action_count,
    skippedActionCount: row.skipped_action_count,
    safeErrorMessage: row.safe_error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

async function loadActions(tenantId: number, ruleId: number) {
  const result = await query(
    `SELECT * FROM automation_actions
     WHERE tenant_id = $1 AND automation_rule_id = $2
     ORDER BY action_order ASC, id ASC`,
    [tenantId, ruleId]
  );
  return result.rows;
}

async function replaceActions(
  tenantId: number,
  ruleId: number,
  actions: any[]
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!Array.isArray(actions)) return { ok: false, error: 'actions dizi olmalı' };
  if (actions.length > MAX_ACTIONS_PER_RULE) {
    return { ok: false, error: `En fazla ${MAX_ACTIONS_PER_RULE} aksiyon` };
  }
  for (const a of actions) {
    if (!isAutomationActionType(a.actionType || a.action_type)) {
      return { ok: false, error: `Geçersiz aksiyon: ${a.actionType || a.action_type}` };
    }
    const delay = Number(a.delaySeconds ?? a.delay_seconds ?? 0);
    if (!Number.isFinite(delay) || delay < 0 || delay > MAX_DELAY_SECONDS) {
      return { ok: false, error: `delaySeconds 0-${MAX_DELAY_SECONDS} olmalı` };
    }
  }

  await query(`DELETE FROM automation_actions WHERE automation_rule_id = $1 AND tenant_id = $2`, [
    ruleId,
    tenantId,
  ]);

  let order = 0;
  for (const a of actions) {
    const actionType = a.actionType || a.action_type;
    const delay = Math.min(
      MAX_DELAY_SECONDS,
      Math.max(0, Number(a.delaySeconds ?? a.delay_seconds ?? 0) || 0)
    );
    const config = a.config && typeof a.config === 'object' ? a.config : {};
    await query(
      `INSERT INTO automation_actions (
         tenant_id, automation_rule_id, action_type, action_order, delay_seconds, config, is_active
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [
        tenantId,
        ruleId,
        actionType,
        Number.isFinite(Number(a.actionOrder)) ? Number(a.actionOrder) : order,
        delay,
        JSON.stringify(config),
        a.isActive !== false,
      ]
    );
    order += 1;
  }
  return { ok: true };
}

router.get('/', requirePermission('AUTOMATION_VIEW'), async (req: AuthRequest, res: Response) => {
  try {
    if (!(await ensureFeature(req, res))) return;
    const tenantId = req.user!.tenantId;
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    const params: any[] = [tenantId];
    let sql = `SELECT * FROM automation_rules WHERE tenant_id = $1 AND status <> 'ARCHIVED'`;
    if (status && (AUTOMATION_STATUSES as readonly string[]).includes(status)) {
      params.push(status);
      sql += ` AND status = $${params.length}`;
    }
    sql += ` ORDER BY updated_at DESC, id DESC`;
    const result = await query(sql, params);
    const data = [];
    for (const row of result.rows) {
      const actions = await loadActions(tenantId, row.id);
      data.push(sanitizeRule(row, actions));
    }
    res.json({ success: true, data });
  } catch (error) {
    console.error('List automation error:', error);
    res.status(500).json({ error: 'Otomasyonlar alınamadı' });
  }
});

router.post('/', requirePermission('AUTOMATION_MANAGE'), async (req: AuthRequest, res: Response) => {
  try {
    if (!(await ensureFeature(req, res))) return;
    if (!(await ensureWritable(req, res))) return;
    const tenantId = req.user!.tenantId;
    const name = String(req.body.name || '').trim().slice(0, 255);
    const description = req.body.description
      ? String(req.body.description).slice(0, 2000)
      : null;
    const triggerType = String(req.body.triggerType || req.body.trigger_type || '').toUpperCase();
    const brandId = req.body.brandId ?? req.body.brand_id ?? null;
    const status = String(req.body.status || 'DRAFT').toUpperCase();

    if (!name) return badRequest(res, 'name zorunlu');
    if (!isAutomationTrigger(triggerType)) return badRequest(res, 'Geçersiz triggerType');
    if (!['DRAFT', 'ACTIVE', 'PAUSED'].includes(status)) {
      return badRequest(res, 'Geçersiz status');
    }

    const cond = validateConditionsInput(req.body.conditions);
    if (cond.ok === false) return badRequest(res, cond.error);

    if (status === 'ACTIVE') {
      const queue = await assertAutomationQueueReady();
      if (!queue.ok) {
        return res.status(503).json({
          error: queue.error,
          code: 'AUTOMATION_QUEUE_UNAVAILABLE',
        });
      }
    }

    if (brandId != null) {
      const b = await query(`SELECT id FROM brands WHERE id = $1 AND tenant_id = $2`, [
        Number(brandId),
        tenantId,
      ]);
      if (!b.rows[0]) return notFound(res);
    }

    const inserted = await query(
      `INSERT INTO automation_rules (
         name, description, tenant_id, brand_id, trigger_type, trigger_config,
         conditions, actions, status, is_active, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'[]'::jsonb,$8,$9,$10)
       RETURNING *`,
      [
        name,
        description,
        tenantId,
        brandId != null ? Number(brandId) : null,
        triggerType,
        JSON.stringify(req.body.triggerConfig || {}),
        JSON.stringify(cond.conditions),
        status,
        status === 'ACTIVE',
        req.user!.userId,
      ]
    );

    const actions = Array.isArray(req.body.actions) ? req.body.actions : [];
    const replaced = await replaceActions(tenantId, inserted.rows[0].id, actions);
    if (replaced.ok === false) return badRequest(res, replaced.error);

    const loaded = await loadActions(tenantId, inserted.rows[0].id);
    res.status(201).json({ success: true, data: sanitizeRule(inserted.rows[0], loaded) });
  } catch (error: any) {
    if (respondEntitlementError(res, error)) return;
    console.error('Create automation error:', error);
    res.status(500).json({ error: 'Otomasyon oluşturulamadı' });
  }
});

router.get(
  '/executions/:executionId',
  requirePermission('AUTOMATION_VIEW'),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!(await ensureFeature(req, res))) return;
      const tenantId = req.user!.tenantId;
      const executionId = Number(req.params.executionId);
      const exec = await query(
        `SELECT * FROM automation_executions WHERE id = $1 AND tenant_id = $2`,
        [executionId, tenantId]
      );
      if (!exec.rows[0]) return notFound(res);
      const actions = await query(
        `SELECT * FROM automation_action_executions
         WHERE automation_execution_id = $1 AND tenant_id = $2
         ORDER BY id ASC`,
        [executionId, tenantId]
      );
      res.json({
        success: true,
        data: {
          ...sanitizeExecution(exec.rows[0]),
          actionExecutions: actions.rows.map((a: any) => ({
            id: a.id,
            automationActionId: a.automation_action_id,
            status: a.status,
            outboundMessageId: a.outbound_message_id,
            attemptCount: a.attempt_count,
            safeErrorMessage: a.safe_error_message,
            resultMeta: a.result_meta,
            scheduledAt: a.scheduled_at,
            startedAt: a.started_at,
            completedAt: a.completed_at,
          })),
        },
      });
    } catch (error) {
      console.error('Get execution error:', error);
      res.status(500).json({ error: 'Çalıştırma alınamadı' });
    }
  }
);

router.get('/:id', requirePermission('AUTOMATION_VIEW'), async (req: AuthRequest, res: Response) => {
  try {
    if (!(await ensureFeature(req, res))) return;
    const tenantId = req.user!.tenantId;
    const id = Number(req.params.id);
    const result = await query(
      `SELECT * FROM automation_rules WHERE id = $1 AND tenant_id = $2 AND status <> 'ARCHIVED'`,
      [id, tenantId]
    );
    if (!result.rows[0]) return notFound(res);
    const actions = await loadActions(tenantId, id);
    res.json({ success: true, data: sanitizeRule(result.rows[0], actions) });
  } catch (error) {
    console.error('Get automation error:', error);
    res.status(500).json({ error: 'Otomasyon alınamadı' });
  }
});

router.patch('/:id', requirePermission('AUTOMATION_MANAGE'), async (req: AuthRequest, res: Response) => {
  try {
    if (!(await ensureFeature(req, res))) return;
    if (!(await ensureWritable(req, res))) return;
    const tenantId = req.user!.tenantId;
    const id = Number(req.params.id);
    const existing = await query(
      `SELECT * FROM automation_rules WHERE id = $1 AND tenant_id = $2 AND status <> 'ARCHIVED'`,
      [id, tenantId]
    );
    if (!existing.rows[0]) return notFound(res);

    const name =
      req.body.name !== undefined
        ? String(req.body.name).trim().slice(0, 255)
        : existing.rows[0].name;
    const description =
      req.body.description !== undefined
        ? String(req.body.description || '').slice(0, 2000)
        : existing.rows[0].description;
    const triggerType =
      req.body.triggerType || req.body.trigger_type
        ? String(req.body.triggerType || req.body.trigger_type).toUpperCase()
        : existing.rows[0].trigger_type;
    if (!isAutomationTrigger(triggerType)) return badRequest(res, 'Geçersiz triggerType');

    let conditions = existing.rows[0].conditions;
    if (req.body.conditions !== undefined) {
      const cond = validateConditionsInput(req.body.conditions);
      if (cond.ok === false) return badRequest(res, cond.error);
      conditions = cond.conditions;
    }

    const brandId =
      req.body.brandId !== undefined || req.body.brand_id !== undefined
        ? req.body.brandId ?? req.body.brand_id
        : existing.rows[0].brand_id;

    const status =
      req.body.status !== undefined
        ? String(req.body.status).toUpperCase()
        : existing.rows[0].status;
    if (!['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'].includes(status)) {
      return badRequest(res, 'Geçersiz status');
    }
    if (status === 'ACTIVE') {
      const queue = await assertAutomationQueueReady();
      if (!queue.ok) {
        return res.status(503).json({
          error: queue.error,
          code: 'AUTOMATION_QUEUE_UNAVAILABLE',
        });
      }
    }

    const updated = await query(
      `UPDATE automation_rules SET
         name = $1, description = $2, trigger_type = $3, brand_id = $4,
         conditions = $5::jsonb, status = $6, is_active = $7,
         trigger_config = COALESCE($8::jsonb, trigger_config),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $9 AND tenant_id = $10
       RETURNING *`,
      [
        name,
        description,
        triggerType,
        brandId != null ? Number(brandId) : null,
        JSON.stringify(conditions),
        status,
        status === 'ACTIVE',
        req.body.triggerConfig ? JSON.stringify(req.body.triggerConfig) : null,
        id,
        tenantId,
      ]
    );

    if (req.body.actions !== undefined) {
      const replaced = await replaceActions(tenantId, id, req.body.actions);
      if (replaced.ok === false) return badRequest(res, replaced.error);
    }

    const actions = await loadActions(tenantId, id);
    res.json({ success: true, data: sanitizeRule(updated.rows[0], actions) });
  } catch (error: any) {
    if (respondEntitlementError(res, error)) return;
    console.error('Update automation error:', error);
    res.status(500).json({ error: 'Otomasyon güncellenemedi' });
  }
});

router.delete('/:id', requirePermission('AUTOMATION_MANAGE'), async (req: AuthRequest, res: Response) => {
  try {
    if (!(await ensureFeature(req, res))) return;
    if (!(await ensureWritable(req, res))) return;
    const tenantId = req.user!.tenantId;
    const id = Number(req.params.id);
    const result = await query(
      `UPDATE automation_rules
       SET status = 'ARCHIVED', is_active = false, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND tenant_id = $2 AND status <> 'ARCHIVED'
       RETURNING id`,
      [id, tenantId]
    );
    if (!result.rows[0]) return notFound(res);
    res.json({ success: true, archived: true });
  } catch (error) {
    if (respondEntitlementError(res, error)) return;
    console.error('Archive automation error:', error);
    res.status(500).json({ error: 'Otomasyon arşivlenemedi' });
  }
});

router.post(
  '/:id/activate',
  requirePermission('AUTOMATION_MANAGE'),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!(await ensureFeature(req, res))) return;
      if (!(await ensureWritable(req, res))) return;
      const queue = await assertAutomationQueueReady();
      if (!queue.ok) {
        return res.status(503).json({
          error: queue.error,
          code: 'AUTOMATION_QUEUE_UNAVAILABLE',
        });
      }
      const result = await query(
        `UPDATE automation_rules
         SET status = 'ACTIVE', is_active = true, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND tenant_id = $2 AND status IN ('DRAFT','PAUSED')
         RETURNING *`,
        [Number(req.params.id), req.user!.tenantId]
      );
      if (!result.rows[0]) return notFound(res);
      const actions = await loadActions(req.user!.tenantId, result.rows[0].id);
      res.json({ success: true, data: sanitizeRule(result.rows[0], actions) });
    } catch (error) {
      if (respondEntitlementError(res, error)) return;
      console.error('Activate automation error:', error);
      res.status(500).json({ error: 'Aktifleştirilemedi' });
    }
  }
);

router.post(
  '/:id/pause',
  requirePermission('AUTOMATION_MANAGE'),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!(await ensureFeature(req, res))) return;
      if (!(await ensureWritable(req, res))) return;
      const result = await query(
        `UPDATE automation_rules
         SET status = 'PAUSED', is_active = false, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND tenant_id = $2 AND status = 'ACTIVE'
         RETURNING *`,
        [Number(req.params.id), req.user!.tenantId]
      );
      if (!result.rows[0]) return notFound(res);
      const actions = await loadActions(req.user!.tenantId, result.rows[0].id);
      res.json({ success: true, data: sanitizeRule(result.rows[0], actions) });
    } catch (error) {
      if (respondEntitlementError(res, error)) return;
      console.error('Pause automation error:', error);
      res.status(500).json({ error: 'Duraklatılamadı' });
    }
  }
);

router.post(
  '/:id/duplicate',
  requirePermission('AUTOMATION_MANAGE'),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!(await ensureFeature(req, res))) return;
      if (!(await ensureWritable(req, res))) return;
      const tenantId = req.user!.tenantId;
      const id = Number(req.params.id);
      const src = await query(
        `SELECT * FROM automation_rules WHERE id = $1 AND tenant_id = $2 AND status <> 'ARCHIVED'`,
        [id, tenantId]
      );
      if (!src.rows[0]) return notFound(res);
      const r = src.rows[0];
      const inserted = await query(
        `INSERT INTO automation_rules (
           name, description, tenant_id, brand_id, trigger_type, trigger_config,
           conditions, actions, status, is_active, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'[]'::jsonb,'DRAFT',false,$8)
         RETURNING *`,
        [
          `${String(r.name).slice(0, 240)} (kopya)`,
          r.description,
          tenantId,
          r.brand_id,
          r.trigger_type,
          JSON.stringify(r.trigger_config || {}),
          JSON.stringify(r.conditions || []),
          req.user!.userId,
        ]
      );
      const actions = await loadActions(tenantId, id);
      await replaceActions(
        tenantId,
        inserted.rows[0].id,
        actions.map((a: any) => ({
          actionType: a.action_type,
          actionOrder: a.action_order,
          delaySeconds: a.delay_seconds,
          config: a.config,
          isActive: a.is_active,
        }))
      );
      const loaded = await loadActions(tenantId, inserted.rows[0].id);
      res.status(201).json({ success: true, data: sanitizeRule(inserted.rows[0], loaded) });
    } catch (error) {
      if (respondEntitlementError(res, error)) return;
      console.error('Duplicate automation error:', error);
      res.status(500).json({ error: 'Kopyalanamadı' });
    }
  }
);

router.post(
  '/:id/test',
  requirePermission('AUTOMATION_VIEW'),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!(await ensureFeature(req, res))) return;
      const tenantId = req.user!.tenantId;
      const sample = req.body.samplePayload || req.body.payload || {};
      if (sample.tenantId != null || sample.tenant_id != null) {
        return badRequest(res, 'tenantId test gövdesinde kabul edilmez');
      }
      // Bind sample entities to this tenant only
      if (sample.contactId) {
        const c = await query(`SELECT id FROM contacts WHERE id = $1 AND tenant_id = $2`, [
          Number(sample.contactId),
          tenantId,
        ]);
        if (!c.rows[0]) return badRequest(res, 'Örnek kişi bu tenant’ta yok');
      }
      if (sample.conversationId) {
        const c = await query(`SELECT id FROM conversations WHERE id = $1 AND tenant_id = $2`, [
          Number(sample.conversationId),
          tenantId,
        ]);
        if (!c.rows[0]) return badRequest(res, 'Örnek konuşma bu tenant’ta yok');
      }
      const result = await simulateAutomation({
        tenantId,
        ruleId: Number(req.params.id),
        samplePayload: sample,
      });
      if (!result) return notFound(res);
      res.json({ success: true, data: result });
    } catch (error) {
      console.error('Test automation error:', error);
      res.status(500).json({ error: 'Test çalıştırılamadı' });
    }
  }
);

router.post(
  '/:id/manual-run',
  requirePermission('AUTOMATION_RUN'),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!(await ensureFeature(req, res))) return;
      if (!(await ensureWritable(req, res))) return;
      if (!req.body.confirm) {
        return badRequest(res, 'Gerçek çalıştırma için confirm: true gerekli');
      }
      const queue = await assertAutomationQueueReady();
      if (!queue.ok) {
        return res.status(503).json({
          error: queue.error,
          code: 'AUTOMATION_QUEUE_UNAVAILABLE',
        });
      }

      const tenantId = req.user!.tenantId;
      const id = Number(req.params.id);
      const rule = await query(
        `SELECT * FROM automation_rules WHERE id = $1 AND tenant_id = $2 AND status <> 'ARCHIVED'`,
        [id, tenantId]
      );
      if (!rule.rows[0]) return notFound(res);

      const payload = req.body.payload || {};
      if (payload.tenantId != null || payload.tenant_id != null) {
        return badRequest(res, 'tenantId kabul edilmez');
      }
      // Single-entity only — no campaign fan-out
      const contactIds = payload.contactIds || payload.contact_ids;
      if (Array.isArray(contactIds) && contactIds.length > 1) {
        return badRequest(res, 'Manuel çalıştırma tek kişi ile sınırlıdır');
      }
      if (payload.contactId) {
        const c = await query(`SELECT id FROM contacts WHERE id = $1 AND tenant_id = $2`, [
          Number(payload.contactId),
          tenantId,
        ]);
        if (!c.rows[0]) return badRequest(res, 'Kişi bulunamadı');
      }

      const eventId = buildManualEventId(id, req.user!.userId);
      const inserted = await query(
        `INSERT INTO automation_executions (
           tenant_id, automation_rule_id, trigger_type, trigger_event_id,
           trigger_payload, status, chain_depth
         ) VALUES ($1,$2,'MANUAL',$3,$4::jsonb,'PENDING',0)
         RETURNING id`,
        [
          tenantId,
          id,
          eventId,
          JSON.stringify({
            ...payload,
            manual: true,
            contactId: payload.contactId || (Array.isArray(contactIds) ? contactIds[0] : null),
          }),
        ]
      );

      const { enqueueAutomationExecution } = await import('../queues/automationQueue');
      await enqueueAutomationExecution(inserted.rows[0].id, tenantId);
      // Also allow sync process when queue worker not running in dev
      if (process.env.NODE_ENV !== 'production') {
        try {
          await processAutomationExecution(inserted.rows[0].id, tenantId);
        } catch {
          /* worker will pick up */
        }
      }

      res.status(202).json({
        success: true,
        data: { executionId: inserted.rows[0].id, triggerEventId: eventId },
      });
    } catch (error: any) {
      if (respondEntitlementError(res, error)) return;
      console.error('Manual run error:', error);
      res.status(500).json({ error: 'Manuel çalıştırma başarısız' });
    }
  }
);

router.get(
  '/:id/executions',
  requirePermission('AUTOMATION_VIEW'),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!(await ensureFeature(req, res))) return;
      const tenantId = req.user!.tenantId;
      const id = Number(req.params.id);
      const owned = await query(
        `SELECT id FROM automation_rules WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId]
      );
      if (!owned.rows[0]) return notFound(res);
      const result = await query(
        `SELECT * FROM automation_executions
         WHERE automation_rule_id = $1 AND tenant_id = $2
         ORDER BY created_at DESC
         LIMIT 50`,
        [id, tenantId]
      );
      res.json({ success: true, data: result.rows.map(sanitizeExecution) });
    } catch (error) {
      console.error('List executions error:', error);
      res.status(500).json({ error: 'Geçmiş alınamadı' });
    }
  }
);

export default router;

// silence unused import warning for action types catalog (used by clients via docs)
void AUTOMATION_ACTION_TYPES;
void emitAutomationEventStrict;
