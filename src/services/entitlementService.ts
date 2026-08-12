import { query } from '../config/database';

export type PlanCode =
  | 'INTERNAL'
  | 'STARTER'
  | 'PROFESSIONAL'
  | 'BUSINESS'
  | 'ENTERPRISE'
  | 'CUSTOM'
  | string;

export type TenantLifecycleStatus = 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
export type SubscriptionStatus =
  | 'TRIAL'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'CANCELLED'
  | 'SUSPENDED'
  | 'EXPIRED';

export type LimitKey =
  | 'max_users'
  | 'max_brands'
  | 'max_email_accounts'
  | 'max_sms_connections'
  | 'max_whatsapp_connections'
  | 'max_sender_identities'
  | 'max_contacts'
  | 'max_templates'
  | 'monthly_email_sends'
  | 'monthly_sms_sends'
  | 'monthly_whatsapp_sends'
  | 'storage_bytes';

export type FeatureKey =
  | 'automation'
  | 'unified_inbox'
  | 'deliverability'
  | 'advanced_analytics'
  | 'white_label'
  | 'api_webhooks'
  | 'priority_support';

export type UsageMetric =
  | 'email_sent'
  | 'sms_sent'
  | 'whatsapp_sent'
  | 'contacts_count'
  | 'users_count'
  | 'brands_count'
  | 'email_accounts_count'
  | 'sms_connections_count'
  | 'whatsapp_connections_count'
  | 'templates_count'
  | 'storage_used_bytes';

export class EntitlementError extends Error {
  code: 'QUOTA_EXCEEDED' | 'FEATURE_NOT_AVAILABLE' | 'TENANT_READ_ONLY' | 'NO_SUBSCRIPTION';
  status: number;
  details: Record<string, unknown>;

  constructor(
    code: EntitlementError['code'],
    message: string,
    details: Record<string, unknown> = {},
    status = 402
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function currentPeriodKey(date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

function mergeLimits(
  planLimits: Record<string, unknown>,
  overrides: Record<string, unknown>
): Record<LimitKey, number | null> {
  const keys: LimitKey[] = [
    'max_users',
    'max_brands',
    'max_email_accounts',
    'max_sms_connections',
    'max_whatsapp_connections',
    'max_sender_identities',
    'max_contacts',
    'max_templates',
    'monthly_email_sends',
    'monthly_sms_sends',
    'monthly_whatsapp_sends',
    'storage_bytes',
  ];
  const out = {} as Record<LimitKey, number | null>;
  for (const key of keys) {
    const hasOverride = Object.prototype.hasOwnProperty.call(overrides, key);
    out[key] = hasOverride
      ? asNullableNumber(overrides[key])
      : asNullableNumber(planLimits[key]);
  }
  return out;
}

function mergeFeatures(
  planFeatures: Record<string, unknown> | unknown[],
  overrides: Record<string, unknown>
): Record<FeatureKey, boolean> {
  const base: Record<string, boolean> = {};
  if (Array.isArray(planFeatures)) {
    for (const item of planFeatures) {
      if (typeof item === 'string') base[item] = true;
    }
  } else if (planFeatures && typeof planFeatures === 'object') {
    for (const [k, v] of Object.entries(planFeatures)) {
      base[k] = Boolean(v);
    }
  }
  const keys: FeatureKey[] = [
    'automation',
    'unified_inbox',
    'deliverability',
    'advanced_analytics',
    'white_label',
    'api_webhooks',
    'priority_support',
  ];
  const out = {} as Record<FeatureKey, boolean>;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      out[key] = Boolean(overrides[key]);
    } else {
      out[key] = Boolean(base[key]);
    }
  }
  return out;
}

export async function getTenantSubscription(tenantId: number) {
  const result = await query(
    `SELECT s.*,
            p.id AS plan_table_id,
            p.code AS plan_code,
            p.name AS plan_name,
            p.display_name AS plan_display_name,
            p.limits AS plan_limits,
            p.features AS plan_features,
            p.is_public AS plan_is_public,
            p.monthly_price,
            p.yearly_price,
            p.currency,
            t.status AS tenant_status,
            t.name AS tenant_name,
            t.entitlement_version,
            t.subscription_plan AS tenant_subscription_plan
     FROM subscriptions s
     JOIN plans p ON p.id = s.plan_id
     JOIN tenants t ON t.id = s.tenant_id
     WHERE s.tenant_id = $1
     ORDER BY
       CASE UPPER(s.status)
         WHEN 'ACTIVE' THEN 0 WHEN 'TRIAL' THEN 1 WHEN 'PAST_DUE' THEN 2
         ELSE 3 END,
       s.created_at DESC
     LIMIT 1`,
    [tenantId]
  );
  return result.rows[0] || null;
}

export async function getTenantLimitOverrides(tenantId: number) {
  const result = await query(
    `SELECT * FROM tenant_limit_overrides WHERE tenant_id = $1`,
    [tenantId]
  );
  return result.rows[0] || null;
}

export async function ensureTenantUsageRow(tenantId: number, periodKey = currentPeriodKey()) {
  const result = await query(
    `INSERT INTO tenant_usage (tenant_id, period_key)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id, period_key) DO UPDATE SET updated_at = tenant_usage.updated_at
     RETURNING *`,
    [tenantId, periodKey]
  );
  return result.rows[0];
}

export async function getUsageSnapshot(tenantId: number, periodKey = currentPeriodKey()) {
  await ensureTenantUsageRow(tenantId, periodKey);
  const result = await query(
    `SELECT * FROM tenant_usage WHERE tenant_id = $1 AND period_key = $2`,
    [tenantId, periodKey]
  );
  return result.rows[0];
}

export async function getTenantEntitlements(tenantId: number) {
  const sub = await getTenantSubscription(tenantId);
  if (!sub) {
    throw new EntitlementError('NO_SUBSCRIPTION', 'Aktif abonelik bulunamadı', {}, 403);
  }

  const overrides = await getTenantLimitOverrides(tenantId);
  const planLimits =
    typeof sub.plan_limits === 'object' && sub.plan_limits && !Array.isArray(sub.plan_limits)
      ? sub.plan_limits
      : {};
  const overrideLimits =
    overrides?.limits && typeof overrides.limits === 'object' ? overrides.limits : {};
  const overrideFeatures =
    overrides?.features && typeof overrides.features === 'object' ? overrides.features : {};

  const limits = mergeLimits(planLimits, overrideLimits);
  const features = mergeFeatures(sub.plan_features || {}, overrideFeatures);
  const usage = await getUsageSnapshot(tenantId);
  const subStatus = String(sub.status || '').toUpperCase() as SubscriptionStatus;
  const tenantStatus = String(sub.tenant_status || 'ACTIVE').toUpperCase() as TenantLifecycleStatus;

  const writable =
    tenantStatus === 'ACTIVE' &&
    (subStatus === 'ACTIVE' || subStatus === 'TRIAL' || subStatus === 'PAST_DUE');

  return {
    tenantId,
    tenantName: sub.tenant_name,
    tenantStatus,
    entitlementVersion: Number(sub.entitlement_version) || 1,
    subscription: {
      id: sub.id,
      status: subStatus,
      billingPeriod: String(sub.billing_period || 'MONTHLY').toUpperCase(),
      provider: sub.provider || null,
      trialEndsAt: sub.trial_ends_at || sub.trial_end || null,
      currentPeriodStart: sub.current_period_start,
      currentPeriodEnd: sub.current_period_end,
      cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    },
    plan: {
      id: sub.plan_id,
      code: String(sub.plan_code || sub.plan_name || '').toUpperCase(),
      name: sub.plan_display_name || sub.plan_name,
      currency: sub.currency || 'USD',
      monthlyPrice: sub.monthly_price != null ? Number(sub.monthly_price) : null,
      yearlyPrice: sub.yearly_price != null ? Number(sub.yearly_price) : null,
      isPublic: Boolean(sub.plan_is_public),
    },
    limits,
    features,
    usage,
    periodKey: usage.period_key,
    writable,
  };
}

export function getRemainingQuota(
  limit: number | null | undefined,
  used: number
): number | null {
  if (limit == null) return null;
  return Math.max(0, Number(limit) - Number(used || 0));
}

export async function assertFeatureEnabled(tenantId: number, feature: FeatureKey) {
  const ent = await getTenantEntitlements(tenantId);
  if (!ent.features[feature]) {
    throw new EntitlementError(
      'FEATURE_NOT_AVAILABLE',
      'Bu özellik mevcut planınızda kapalı',
      {
        feature,
        plan: ent.plan.code,
        planName: ent.plan.name,
      },
      403
    );
  }
  return ent;
}

export async function assertTenantWritable(tenantId: number) {
  const ent = await getTenantEntitlements(tenantId);
  if (!ent.writable) {
    throw new EntitlementError(
      'TENANT_READ_ONLY',
      'Hesap askıda veya süresi dolmuş; yeni işlem yapılamaz',
      {
        tenantStatus: ent.tenantStatus,
        subscriptionStatus: ent.subscription.status,
        plan: ent.plan.code,
      },
      403
    );
  }
  return ent;
}

const LIMIT_TO_USAGE: Partial<Record<LimitKey, UsageMetric>> = {
  max_users: 'users_count',
  max_brands: 'brands_count',
  max_email_accounts: 'email_accounts_count',
  max_sms_connections: 'sms_connections_count',
  max_whatsapp_connections: 'whatsapp_connections_count',
  max_contacts: 'contacts_count',
  max_templates: 'templates_count',
  monthly_email_sends: 'email_sent',
  monthly_sms_sends: 'sms_sent',
  monthly_whatsapp_sends: 'whatsapp_sent',
  storage_bytes: 'storage_used_bytes',
};

void LIMIT_TO_USAGE;

export async function assertUsageAvailable(
  tenantId: number,
  limitKey: LimitKey,
  quantity = 1
) {
  const ent = await assertTenantWritable(tenantId);
  const limit = ent.limits[limitKey];
  if (limit == null) return ent;

  let used = 0;
  switch (limitKey) {
    case 'max_users': {
      const c = await query(
        `SELECT
           (SELECT COUNT(*)::int FROM users
            WHERE tenant_id = $1 AND COALESCE(is_active, true) = true
              AND COALESCE(role,'') <> 'super_admin')
           +
           (SELECT COUNT(*)::int FROM invites
            WHERE tenant_id = $1 AND status = 'PENDING'
              AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP))
           AS c`,
        [tenantId]
      );
      used = c.rows[0]?.c || 0;
      break;
    }
    case 'max_brands':
      used = Number(ent.usage.brands_count || 0);
      break;
    case 'max_email_accounts':
      used = Number(ent.usage.email_accounts_count || 0);
      break;
    case 'max_sms_connections':
      used = Number(ent.usage.sms_connections_count || 0);
      break;
    case 'max_whatsapp_connections': {
      const { countWhatsAppConnectionsTowardQuota } = await import(
        '../utils/whatsappConnectionQuota'
      );
      used = await countWhatsAppConnectionsTowardQuota(tenantId);
      break;
    }
    case 'max_sender_identities': {
      const c = await query(
        `SELECT COUNT(*)::int AS c FROM sender_identities WHERE tenant_id = $1`,
        [tenantId]
      );
      used = c.rows[0]?.c || 0;
      break;
    }
    case 'max_contacts':
      used = Number(ent.usage.contacts_count || 0);
      break;
    case 'max_templates':
      used = Number(ent.usage.templates_count || 0);
      break;
    case 'monthly_email_sends':
      used = Number(ent.usage.email_sent || 0);
      break;
    case 'monthly_sms_sends':
      used = Number(ent.usage.sms_sent || 0);
      break;
    case 'monthly_whatsapp_sends':
      used = Number(ent.usage.whatsapp_sent || 0);
      break;
    case 'storage_bytes':
      used = Number(ent.usage.storage_used_bytes || 0);
      break;
  }

  if (used + quantity > limit) {
    throw new EntitlementError(
      'QUOTA_EXCEEDED',
      'Plan kotası aşıldı',
      {
        plan: ent.plan.code,
        planName: ent.plan.name,
        limitKey,
        limit,
        used,
        remaining: getRemainingQuota(limit, used),
        upgradeRequired: true,
      },
      402
    );
  }
  return ent;
}

export async function incrementUsage(
  tenantId: number,
  metric: UsageMetric,
  quantity = 1,
  periodKey = currentPeriodKey()
) {
  await ensureTenantUsageRow(tenantId, periodKey);
  const allowed = new Set([
    'email_sent',
    'sms_sent',
    'whatsapp_sent',
    'contacts_count',
    'users_count',
    'brands_count',
    'email_accounts_count',
    'sms_connections_count',
    'whatsapp_connections_count',
    'templates_count',
    'storage_used_bytes',
  ]);
  if (!allowed.has(metric)) return;
  await query(
    `UPDATE tenant_usage
     SET ${metric} = GREATEST(0, ${metric} + $3),
         updated_at = CURRENT_TIMESTAMP
     WHERE tenant_id = $1 AND period_key = $2`,
    [tenantId, periodKey, quantity]
  );
}

export async function decrementCountUsage(
  tenantId: number,
  metric: UsageMetric,
  quantity = 1,
  periodKey = currentPeriodKey()
) {
  await incrementUsage(tenantId, metric, -Math.abs(quantity), periodKey);
}

export async function recalculateCountUsage(tenantId: number) {
  const periodKey = currentPeriodKey();
  await ensureTenantUsageRow(tenantId, periodKey);

  const [users, brands, accounts, smsConn, waConn, contacts, templates, storage] =
    await Promise.all([
      query(
        `SELECT COUNT(*)::int AS c FROM users
         WHERE tenant_id = $1 AND COALESCE(is_active, true) = true
           AND COALESCE(role,'') <> 'super_admin'`,
        [tenantId]
      ),
      query(`SELECT COUNT(*)::int AS c FROM brands WHERE tenant_id = $1`, [tenantId]),
      query(
        `SELECT COUNT(*)::int AS c FROM mail_accounts WHERE tenant_id = $1 AND COALESCE(is_active, true) = true`,
        [tenantId]
      ),
      query(
        `SELECT COUNT(*)::int AS c FROM channel_connections
         WHERE tenant_id = $1 AND channel_type = 'SMS'`,
        [tenantId]
      ),
      (async () => {
        const { countWhatsAppConnectionsTowardQuota } = await import(
          '../utils/whatsappConnectionQuota'
        );
        const c = await countWhatsAppConnectionsTowardQuota(tenantId);
        return { rows: [{ c }] };
      })(),
      query(
        `SELECT COUNT(*)::int AS c FROM contacts WHERE tenant_id = $1 AND status <> 'ARCHIVED'`,
        [tenantId]
      ),
      query(
        `SELECT COUNT(*)::int AS c FROM templates WHERE tenant_id = $1 AND COALESCE(is_active, true) = true`,
        [tenantId]
      ),
      query(
        `SELECT COALESCE(storage_used_mb, 0)::float AS mb FROM tenants WHERE id = $1`,
        [tenantId]
      ),
    ]);

  const storageBytes = Math.round(Number(storage.rows[0]?.mb || 0) * 1024 * 1024);

  await query(
    `UPDATE tenant_usage SET
       users_count = $3,
       brands_count = $4,
       email_accounts_count = $5,
       sms_connections_count = $6,
       whatsapp_connections_count = $7,
       contacts_count = $8,
       templates_count = $9,
       storage_used_bytes = $10,
       updated_at = CURRENT_TIMESTAMP
     WHERE tenant_id = $1 AND period_key = $2`,
    [
      tenantId,
      periodKey,
      users.rows[0]?.c || 0,
      brands.rows[0]?.c || 0,
      accounts.rows[0]?.c || 0,
      smsConn.rows[0]?.c || 0,
      waConn.rows[0]?.c || 0,
      contacts.rows[0]?.c || 0,
      templates.rows[0]?.c || 0,
      storageBytes,
    ]
  );

  return getUsageSnapshot(tenantId, periodKey);
}

/** Reconcile monthly send counters from usage_reserved outbound rows (source of truth). */
export async function reconcileSendUsage(tenantId: number, periodKey = currentPeriodKey()) {
  await ensureTenantUsageRow(tenantId, periodKey);
  const sendCounts = await query(
    `SELECT
       COUNT(*) FILTER (WHERE channel_type = 'EMAIL' AND COALESCE(usage_reserved, false) = true)::int AS email_sent,
       COUNT(*) FILTER (WHERE channel_type = 'SMS' AND COALESCE(usage_reserved, false) = true)::int AS sms_sent,
       COUNT(*) FILTER (WHERE channel_type = 'WHATSAPP' AND COALESCE(usage_reserved, false) = true)::int AS whatsapp_sent
     FROM outbound_messages
     WHERE tenant_id = $1
       AND created_at >= date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
       AND created_at < date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '1 month'`,
    [tenantId]
  );
  await query(
    `UPDATE tenant_usage SET
       email_sent = $3,
       sms_sent = $4,
       whatsapp_sent = $5,
       updated_at = CURRENT_TIMESTAMP
     WHERE tenant_id = $1 AND period_key = $2`,
    [
      tenantId,
      periodKey,
      sendCounts.rows[0]?.email_sent || 0,
      sendCounts.rows[0]?.sms_sent || 0,
      sendCounts.rows[0]?.whatsapp_sent || 0,
    ]
  );
  return getUsageSnapshot(tenantId, periodKey);
}

export async function bumpEntitlementVersion(tenantId: number) {
  await query(
    `UPDATE tenants
     SET entitlement_version = COALESCE(entitlement_version, 1) + 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [tenantId]
  );
}

export function respondEntitlementError(res: any, error: unknown) {
  if (error instanceof EntitlementError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
      ...error.details,
    });
  }
  return null;
}

export function channelSendLimitKey(
  channel: 'EMAIL' | 'SMS' | 'WHATSAPP'
): LimitKey {
  if (channel === 'SMS') return 'monthly_sms_sends';
  if (channel === 'WHATSAPP') return 'monthly_whatsapp_sends';
  return 'monthly_email_sends';
}

export function channelSendMetric(
  channel: 'EMAIL' | 'SMS' | 'WHATSAPP'
): UsageMetric {
  if (channel === 'SMS') return 'sms_sent';
  if (channel === 'WHATSAPP') return 'whatsapp_sent';
  return 'email_sent';
}

export function sanitizeEntitlementsSummary(ent: Awaited<ReturnType<typeof getTenantEntitlements>>) {
  const usagePct = (limit: number | null, used: number) => {
    if (limit == null) return null;
    if (limit <= 0) return 100;
    return Math.min(100, Math.round((used / limit) * 100));
  };

  return {
    planCode: ent.plan.code,
    planName: ent.plan.name,
    subscriptionStatus: ent.subscription.status,
    tenantStatus: ent.tenantStatus,
    billingPeriod: ent.subscription.billingPeriod,
    periodStart: ent.subscription.currentPeriodStart,
    periodEnd: ent.subscription.currentPeriodEnd,
    writable: ent.writable,
    entitlementVersion: ent.entitlementVersion,
    limits: ent.limits,
    features: ent.features,
    usage: {
      email_sent: ent.usage.email_sent,
      sms_sent: ent.usage.sms_sent,
      whatsapp_sent: ent.usage.whatsapp_sent,
      contacts_count: ent.usage.contacts_count,
      users_count: ent.usage.users_count,
      brands_count: ent.usage.brands_count,
      email_accounts_count: ent.usage.email_accounts_count,
      sms_connections_count: ent.usage.sms_connections_count,
      whatsapp_connections_count: ent.usage.whatsapp_connections_count,
      templates_count: ent.usage.templates_count,
      storage_used_bytes: ent.usage.storage_used_bytes,
    },
    remaining: {
      monthly_email_sends: getRemainingQuota(ent.limits.monthly_email_sends, ent.usage.email_sent),
      monthly_sms_sends: getRemainingQuota(ent.limits.monthly_sms_sends, ent.usage.sms_sent),
      monthly_whatsapp_sends: getRemainingQuota(
        ent.limits.monthly_whatsapp_sends,
        ent.usage.whatsapp_sent
      ),
      max_users: getRemainingQuota(ent.limits.max_users, ent.usage.users_count),
      max_contacts: getRemainingQuota(ent.limits.max_contacts, ent.usage.contacts_count),
    },
    warnings: {
      email:
        usagePct(ent.limits.monthly_email_sends, ent.usage.email_sent) != null &&
        usagePct(ent.limits.monthly_email_sends, ent.usage.email_sent)! >= 80,
      sms:
        usagePct(ent.limits.monthly_sms_sends, ent.usage.sms_sent) != null &&
        usagePct(ent.limits.monthly_sms_sends, ent.usage.sms_sent)! >= 80,
      whatsapp:
        usagePct(ent.limits.monthly_whatsapp_sends, ent.usage.whatsapp_sent) != null &&
        usagePct(ent.limits.monthly_whatsapp_sends, ent.usage.whatsapp_sent)! >= 80,
    },
  };
}
