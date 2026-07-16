import { Router, Response } from 'express';
import { authenticate, AuthRequest, isSuperAdmin } from '../middleware/auth';
import { query } from '../config/database';
import { badRequest, notFound } from '../utils/channelPlatform';
import {
  bumpEntitlementVersion,
  getTenantEntitlements,
  getTenantSubscription,
  getUsageSnapshot,
  recalculateCountUsage,
  sanitizeEntitlementsSummary,
  currentPeriodKey,
} from '../services/entitlementService';

const router = Router();
router.use(authenticate);
router.use(isSuperAdmin);

async function writeAudit(params: {
  actorUserId: number;
  action: string;
  entityType: string;
  entityId?: number | null;
  tenantId?: number | null;
  before?: unknown;
  after?: unknown;
}) {
  await query(
    `INSERT INTO platform_audit_logs
      (actor_user_id, action, entity_type, entity_id, tenant_id, before_data, after_data)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
    [
      params.actorUserId,
      params.action,
      params.entityType,
      params.entityId || null,
      params.tenantId || null,
      JSON.stringify(params.before || null),
      JSON.stringify(params.after || null),
    ]
  );
}

function sanitizeTenantRow(row: any) {
  return {
    id: row.id,
    name: row.name,
    status: row.status || (row.is_active === false ? 'SUSPENDED' : 'ACTIVE'),
    is_active: row.is_active !== false,
    subscription_plan: row.subscription_plan,
    created_at: row.created_at,
    updated_at: row.updated_at,
    storage_used_mb: row.storage_used_mb,
    users_count: row.users_count,
    plan_code: row.plan_code,
    subscription_status: row.subscription_status,
  };
}

router.get('/overview', async (_req: AuthRequest, res: Response) => {
  try {
    const periodKey = currentPeriodKey();
    const [tenants, byStatus, byPlan, usage, failed, recent] = await Promise.all([
      query(`SELECT COUNT(*)::int AS c FROM tenants`),
      query(
        `SELECT COALESCE(status, 'ACTIVE') AS status, COUNT(*)::int AS c
         FROM tenants GROUP BY COALESCE(status, 'ACTIVE')`
      ),
      query(
        `SELECT COALESCE(UPPER(p.code), UPPER(t.subscription_plan), 'UNKNOWN') AS plan_code,
                COUNT(*)::int AS c
         FROM tenants t
         LEFT JOIN LATERAL (
           SELECT s.plan_id FROM subscriptions s
           WHERE s.tenant_id = t.id
           ORDER BY s.created_at DESC LIMIT 1
         ) ls ON true
         LEFT JOIN plans p ON p.id = ls.plan_id
         GROUP BY 1`
      ),
      query(
        `SELECT
           COALESCE(SUM(email_sent),0)::int AS email_sent,
           COALESCE(SUM(sms_sent),0)::int AS sms_sent,
           COALESCE(SUM(whatsapp_sent),0)::int AS whatsapp_sent
         FROM tenant_usage WHERE period_key = $1`,
        [periodKey]
      ),
      query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
           COUNT(*) FILTER (WHERE status IN ('SENT','DELIVERED','READ','FAILED','QUEUED','PROCESSING'))::int AS total
         FROM outbound_messages
         WHERE created_at >= date_trunc('month', CURRENT_TIMESTAMP)`
      ),
      query(
        `SELECT id, name, status, created_at FROM tenants
         ORDER BY created_at DESC LIMIT 8`
      ),
    ]);

    const statusMap: Record<string, number> = {};
    for (const r of byStatus.rows) statusMap[r.status] = r.c;

    res.json({
      success: true,
      data: {
        activeTenants: statusMap.ACTIVE || 0,
        suspendedTenants: statusMap.SUSPENDED || 0,
        archivedTenants: statusMap.ARCHIVED || 0,
        totalTenants: tenants.rows[0]?.c || 0,
        trialTenants: (
          await query(
            `SELECT COUNT(DISTINCT tenant_id)::int AS c FROM subscriptions WHERE UPPER(status) = 'TRIAL'`
          )
        ).rows[0]?.c || 0,
        planDistribution: byPlan.rows,
        monthlyChannelUsage: usage.rows[0] || {
          email_sent: 0,
          sms_sent: 0,
          whatsapp_sent: 0,
        },
        outboundFailureRate:
          Number(failed.rows[0]?.total || 0) > 0
            ? Number(
                (
                  (Number(failed.rows[0]?.failed || 0) / Number(failed.rows[0]?.total || 1)) *
                  100
                ).toFixed(1)
              )
            : 0,
        recentTenants: recent.rows.map(sanitizeTenantRow),
      },
    });
  } catch (error) {
    console.error('Platform overview error:', error);
    res.status(500).json({ error: 'Genel bakış alınamadı' });
  }
});

router.get('/tenants', async (req: AuthRequest, res: Response) => {
  try {
    const q = String(req.query.q || '').trim();
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    const params: any[] = [];
    const clauses: string[] = ['1=1'];
    if (q) {
      params.push(`%${q.replace(/[%_]/g, '')}%`);
      clauses.push(`t.name ILIKE $${params.length}`);
    }
    if (status && ['ACTIVE', 'SUSPENDED', 'ARCHIVED'].includes(status)) {
      params.push(status);
      clauses.push(`COALESCE(t.status, 'ACTIVE') = $${params.length}`);
    }

    const result = await query(
      `SELECT t.id, t.name, t.status, t.is_active, t.subscription_plan, t.created_at, t.updated_at,
              t.storage_used_mb,
              (SELECT COUNT(*)::int FROM users u
                WHERE u.tenant_id = t.id AND COALESCE(u.role,'') <> 'super_admin') AS users_count,
              p.code AS plan_code,
              s.status AS subscription_status
       FROM tenants t
       LEFT JOIN LATERAL (
         SELECT * FROM subscriptions sx WHERE sx.tenant_id = t.id
         ORDER BY sx.created_at DESC LIMIT 1
       ) s ON true
       LEFT JOIN plans p ON p.id = s.plan_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY t.created_at DESC
       LIMIT 200`,
      params
    );
    res.json({ success: true, data: result.rows.map(sanitizeTenantRow) });
  } catch (error) {
    console.error('Platform tenants list error:', error);
    res.status(500).json({ error: 'Tenant listesi alınamadı' });
  }
});

router.get('/tenants/:id', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = Number(req.params.id);
    const tenant = await query(
      `SELECT id, name, status, is_active, subscription_plan, created_at, updated_at, storage_used_mb
       FROM tenants WHERE id = $1`,
      [tenantId]
    );
    if (!tenant.rows[0]) return notFound(res);

    await recalculateCountUsage(tenantId);
    let entitlements;
    try {
      entitlements = sanitizeEntitlementsSummary(await getTenantEntitlements(tenantId));
    } catch {
      entitlements = null;
    }

    const owners = await query(
      `SELECT id, email, name, tenant_role, COALESCE(is_active,true) AS is_active
       FROM users
       WHERE tenant_id = $1 AND COALESCE(role,'') <> 'super_admin'
       ORDER BY CASE tenant_role WHEN 'OWNER' THEN 0 ELSE 1 END, id
       LIMIT 20`,
      [tenantId]
    );

    const overrides = await query(
      `SELECT limits, features, notes, updated_at FROM tenant_limit_overrides WHERE tenant_id = $1`,
      [tenantId]
    );

    res.json({
      success: true,
      data: {
        tenant: sanitizeTenantRow(tenant.rows[0]),
        entitlements,
        limitOverrides: overrides.rows[0] || null,
        members: owners.rows.map((u: any) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          tenant_role: u.tenant_role,
          is_active: u.is_active,
        })),
      },
    });
  } catch (error) {
    console.error('Platform tenant detail error:', error);
    res.status(500).json({ error: 'Tenant detayı alınamadı' });
  }
});

router.patch('/tenants/:id/status', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = Number(req.params.id);
    const status = String(req.body.status || '').toUpperCase();
    if (!['ACTIVE', 'SUSPENDED', 'ARCHIVED'].includes(status)) {
      return badRequest(res, 'Geçersiz status');
    }
    const before = await query(`SELECT id, status, is_active FROM tenants WHERE id = $1`, [
      tenantId,
    ]);
    if (!before.rows[0]) return notFound(res);

    const isActive = status === 'ACTIVE';
    await query(
      `UPDATE tenants
       SET status = $1, is_active = $2, entitlement_version = COALESCE(entitlement_version,1)+1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [status, isActive, tenantId]
    );

    if (status === 'SUSPENDED') {
      await query(
        `UPDATE subscriptions SET status = 'SUSPENDED', updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $1 AND UPPER(status) IN ('ACTIVE','TRIAL','PAST_DUE')`,
        [tenantId]
      );
    }
    if (status === 'ACTIVE') {
      await query(
        `UPDATE subscriptions SET status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $1 AND UPPER(status) = 'SUSPENDED'`,
        [tenantId]
      );
    }

    const after = await query(`SELECT id, status, is_active FROM tenants WHERE id = $1`, [
      tenantId,
    ]);
    await writeAudit({
      actorUserId: req.user!.userId,
      action: status === 'ACTIVE' ? 'TENANT_ACTIVATED' : `TENANT_${status}`,
      entityType: 'tenant',
      entityId: tenantId,
      tenantId,
      before: before.rows[0],
      after: after.rows[0],
    });

    res.json({ success: true, data: sanitizeTenantRow(after.rows[0]) });
  } catch (error) {
    console.error('Platform tenant status error:', error);
    res.status(500).json({ error: 'Durum güncellenemedi' });
  }
});

router.patch('/tenants/:id/plan', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = Number(req.params.id);
    const planCode = String(req.body.planCode || req.body.code || '').toUpperCase();
    const billingPeriod = String(req.body.billingPeriod || 'MONTHLY').toUpperCase();
    if (!planCode) return badRequest(res, 'planCode gerekli');

    const plan = await query(`SELECT * FROM plans WHERE UPPER(code) = $1 OR UPPER(name) = $1`, [
      planCode,
    ]);
    if (!plan.rows[0]) return notFound(res);

    // INTERNAL only via this platform endpoint (already super_admin only)
    const before = await getTenantSubscription(tenantId);

    const periodStart = new Date();
    const periodEnd = new Date(periodStart);
    if (billingPeriod === 'YEARLY') periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    else periodEnd.setMonth(periodEnd.getMonth() + 1);

    const status = planCode === 'INTERNAL' ? 'ACTIVE' : 'ACTIVE';
    const provider = planCode === 'INTERNAL' ? 'internal' : 'manual';
    const bp = planCode === 'INTERNAL' ? 'INTERNAL' : billingPeriod;

    const existing = await query(
      `SELECT id FROM subscriptions WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [tenantId]
    );

    let sub;
    if (existing.rows[0]) {
      sub = await query(
        `UPDATE subscriptions SET
           plan_id = $1, status = $2, billing_period = $3, provider = $4,
           current_period_start = $5, current_period_end = $6, updated_at = CURRENT_TIMESTAMP
         WHERE id = $7 RETURNING *`,
        [
          plan.rows[0].id,
          status,
          bp,
          provider,
          periodStart,
          periodEnd,
          existing.rows[0].id,
        ]
      );
    } else {
      sub = await query(
        `INSERT INTO subscriptions (
           tenant_id, plan_id, status, billing_period, provider,
           current_period_start, current_period_end, cancel_at_period_end
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,false) RETURNING *`,
        [tenantId, plan.rows[0].id, status, bp, provider, periodStart, periodEnd]
      );
    }

    await query(
      `UPDATE tenants SET subscription_plan = $1, entitlement_version = COALESCE(entitlement_version,1)+1,
         updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [String(plan.rows[0].code || plan.rows[0].name).toLowerCase(), tenantId]
    );

    await writeAudit({
      actorUserId: req.user!.userId,
      action: 'PLAN_CHANGED',
      entityType: 'subscription',
      entityId: sub.rows[0].id,
      tenantId,
      before: before
        ? { planCode: before.plan_code, status: before.status }
        : null,
      after: { planCode: plan.rows[0].code, status: sub.rows[0].status },
    });

    const ent = sanitizeEntitlementsSummary(await getTenantEntitlements(tenantId));
    res.json({ success: true, data: ent });
  } catch (error) {
    console.error('Platform plan change error:', error);
    res.status(500).json({ error: 'Plan güncellenemedi' });
  }
});

router.patch('/tenants/:id/limits', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = Number(req.params.id);
    const tenant = await query(`SELECT id FROM tenants WHERE id = $1`, [tenantId]);
    if (!tenant.rows[0]) return notFound(res);

    const limits = req.body.limits && typeof req.body.limits === 'object' ? req.body.limits : {};
    const features =
      req.body.features && typeof req.body.features === 'object' ? req.body.features : {};
    const notes = req.body.notes ? String(req.body.notes).slice(0, 1000) : null;

    const before = await query(`SELECT * FROM tenant_limit_overrides WHERE tenant_id = $1`, [
      tenantId,
    ]);

    const result = await query(
      `INSERT INTO tenant_limit_overrides (tenant_id, limits, features, notes, updated_by)
       VALUES ($1, $2::jsonb, $3::jsonb, $4, $5)
       ON CONFLICT (tenant_id) DO UPDATE SET
         limits = EXCLUDED.limits,
         features = EXCLUDED.features,
         notes = EXCLUDED.notes,
         updated_by = EXCLUDED.updated_by,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        tenantId,
        JSON.stringify(limits),
        JSON.stringify(features),
        notes,
        req.user!.userId,
      ]
    );

    await bumpEntitlementVersion(tenantId);
    await writeAudit({
      actorUserId: req.user!.userId,
      action: 'LIMIT_OVERRIDE_UPDATED',
      entityType: 'tenant_limit_overrides',
      entityId: result.rows[0].id,
      tenantId,
      before: before.rows[0]
        ? { limits: before.rows[0].limits, features: before.rows[0].features }
        : null,
      after: { limits: result.rows[0].limits, features: result.rows[0].features },
    });

    res.json({
      success: true,
      data: {
        limits: result.rows[0].limits,
        features: result.rows[0].features,
        notes: result.rows[0].notes,
      },
    });
  } catch (error) {
    console.error('Platform limits error:', error);
    res.status(500).json({ error: 'Limitler güncellenemedi' });
  }
});

router.get('/tenants/:id/usage', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = Number(req.params.id);
    const tenant = await query(`SELECT id FROM tenants WHERE id = $1`, [tenantId]);
    if (!tenant.rows[0]) return notFound(res);
    await recalculateCountUsage(tenantId);
    const { reconcileSendUsage } = await import('../services/entitlementService');
    await reconcileSendUsage(tenantId);
    const usage = await getUsageSnapshot(tenantId);
    const ent = sanitizeEntitlementsSummary(await getTenantEntitlements(tenantId));
    res.json({ success: true, data: { usage, entitlements: ent } });
  } catch (error) {
    console.error('Platform usage error:', error);
    res.status(500).json({ error: 'Kullanım alınamadı' });
  }
});

router.get('/plans', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT id, code, name, display_name, description, is_active, is_public,
              monthly_price, yearly_price, currency, limits, features, created_at, updated_at
       FROM plans
       ORDER BY COALESCE(monthly_price, price_monthly, 0) ASC, id ASC`
    );
    res.json({
      success: true,
      data: result.rows.map((p: any) => ({
        id: p.id,
        code: p.code || p.name,
        name: p.display_name || p.name,
        description: p.description,
        isActive: p.is_active !== false,
        isPublic: p.is_public !== false,
        monthlyPrice: p.monthly_price != null ? Number(p.monthly_price) : null,
        yearlyPrice: p.yearly_price != null ? Number(p.yearly_price) : null,
        currency: p.currency || 'USD',
        limits: p.limits || {},
        features: p.features || {},
      })),
    });
  } catch (error) {
    console.error('Platform plans list error:', error);
    res.status(500).json({ error: 'Planlar alınamadı' });
  }
});

router.post('/plans', async (req: AuthRequest, res: Response) => {
  try {
    const code = String(req.body.code || '').toUpperCase().trim();
    const displayName = String(req.body.name || req.body.displayName || code).trim();
    if (!code || !displayName) return badRequest(res, 'code ve name gerekli');

    const result = await query(
      `INSERT INTO plans (
         name, code, display_name, description, price_monthly, price_yearly,
         monthly_price, yearly_price, currency, is_active, is_public,
         max_accounts, max_users, max_daily_fetch, max_storage_mb, limits, features
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$5,$6,$7,$8,$9,
         10,10,10000,10240,$10::jsonb,$11::jsonb
       ) RETURNING *`,
      [
        code.toLowerCase(),
        code,
        displayName,
        req.body.description || null,
        Number(req.body.monthlyPrice || 0),
        Number(req.body.yearlyPrice || 0),
        String(req.body.currency || 'USD').slice(0, 3),
        req.body.isActive !== false,
        Boolean(req.body.isPublic),
        JSON.stringify(req.body.limits || {}),
        JSON.stringify(req.body.features || {}),
      ]
    );

    await writeAudit({
      actorUserId: req.user!.userId,
      action: 'PLAN_CREATED',
      entityType: 'plan',
      entityId: result.rows[0].id,
      after: { code, name: displayName },
    });

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    if (error.code === '23505') return badRequest(res, 'Plan kodu zaten var');
    console.error('Platform plan create error:', error);
    res.status(500).json({ error: 'Plan oluşturulamadı' });
  }
});

router.patch('/plans/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const before = await query(`SELECT * FROM plans WHERE id = $1`, [id]);
    if (!before.rows[0]) return notFound(res);

    const b = before.rows[0];
    const result = await query(
      `UPDATE plans SET
         display_name = COALESCE($2, display_name),
         description = COALESCE($3, description),
         monthly_price = COALESCE($4, monthly_price),
         yearly_price = COALESCE($5, yearly_price),
         price_monthly = COALESCE($4, price_monthly),
         price_yearly = COALESCE($5, price_yearly),
         is_active = COALESCE($6, is_active),
         is_public = COALESCE($7, is_public),
         limits = COALESCE($8::jsonb, limits),
         features = COALESCE($9::jsonb, features),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [
        id,
        req.body.name || req.body.displayName || null,
        req.body.description !== undefined ? req.body.description : null,
        req.body.monthlyPrice != null ? Number(req.body.monthlyPrice) : null,
        req.body.yearlyPrice != null ? Number(req.body.yearlyPrice) : null,
        req.body.isActive != null ? Boolean(req.body.isActive) : null,
        req.body.isPublic != null ? Boolean(req.body.isPublic) : null,
        req.body.limits ? JSON.stringify(req.body.limits) : null,
        req.body.features ? JSON.stringify(req.body.features) : null,
      ]
    );

    await writeAudit({
      actorUserId: req.user!.userId,
      action: 'PLAN_UPDATED',
      entityType: 'plan',
      entityId: id,
      before: {
        display_name: b.display_name,
        limits: b.limits,
        features: b.features,
        is_active: b.is_active,
      },
      after: {
        display_name: result.rows[0].display_name,
        limits: result.rows[0].limits,
        features: result.rows[0].features,
        is_active: result.rows[0].is_active,
      },
    });

    // Bump all tenants on this plan
    await query(
      `UPDATE tenants t SET entitlement_version = COALESCE(entitlement_version,1)+1
       FROM subscriptions s
       WHERE s.tenant_id = t.id AND s.plan_id = $1`,
      [id]
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Platform plan update error:', error);
    res.status(500).json({ error: 'Plan güncellenemedi' });
  }
});

router.get('/activity', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
    const params: any[] = [];
    let where = '1=1';
    if (tenantId) {
      params.push(tenantId);
      where = `tenant_id = $${params.length}`;
    }
    const result = await query(
      `SELECT a.*, u.email AS actor_email
       FROM platform_audit_logs a
       LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE ${where}
       ORDER BY a.created_at DESC
       LIMIT 100`,
      params
    );
    res.json({
      success: true,
      data: result.rows.map((r: any) => ({
        id: r.id,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        tenantId: r.tenant_id,
        actorEmail: r.actor_email,
        before: r.before_data,
        after: r.after_data,
        createdAt: r.created_at,
      })),
    });
  } catch (error) {
    console.error('Platform activity error:', error);
    res.status(500).json({ error: 'Aktivite alınamadı' });
  }
});

export default router;
