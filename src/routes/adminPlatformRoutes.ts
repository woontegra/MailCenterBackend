/**
 * Platform SUPER_ADMIN APIs at /api/admin-platform/*
 * Platform role is users.role === 'super_admin' (not tenant_role).
 */
import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate, AuthRequest, requireSuperAdmin } from '../middleware/auth';
import { query, pool } from '../config/database';
import { badRequest, notFound, conflict } from '../utils/channelPlatform';
import { hashPassword } from '../utils/auth';
import { TENANT_ROLES, TenantRole, isTenantRole } from '../permissions/permissionCatalog';

const router = Router();
router.use(authenticate);
router.use(requireSuperAdmin);

const adminWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Çok fazla admin işlemi. Lütfen sonra tekrar deneyin.' },
});

function normalizeEmail(email: string): string {
  return String(email || '').trim().toLowerCase();
}

function validatePasswordPolicy(password: string): string | null {
  const p = String(password || '');
  if (p.length < 8) return 'Şifre en az 8 karakter olmalı';
  if (p.length > 128) return 'Şifre çok uzun';
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) {
    return 'Şifre en az bir harf ve bir rakam içermelidir';
  }
  return null;
}

/** Parse client datetime-local / ISO safely; never pass Invalid Date to pg. */
function parseClientDate(value: unknown): Date | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  // datetime-local without timezone → treat as local wall time
  const normalized =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw) ? `${raw}:00` : raw;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function logAccountCreateError(error: any, step: string) {
  const safe = {
    step,
    message: error?.message ? String(error.message).slice(0, 500) : null,
    code: error?.code || null,
    detail: error?.detail ? String(error.detail).slice(0, 300) : null,
    constraint: error?.constraint || null,
    column: error?.column || null,
    table: error?.table || null,
  };
  console.error('Admin create account error', safe);
}

function mapAccountCreateDbError(res: Response, error: any): Response | null {
  const code = String(error?.code || '');
  const constraint = String(error?.constraint || '');
  const column = String(error?.column || '');
  const message = String(error?.message || '');

  if (code === '23505') {
    if (constraint.includes('users_email') || /email/i.test(message)) {
      return conflict(res, 'Bu e-posta adresi zaten kullanılıyor.');
    }
    if (/tenants.*name|name_key/i.test(constraint + message)) {
      return conflict(res, 'Bu firma adı zaten mevcut.');
    }
    return conflict(res, 'Kayıt çakışması: bu bilgiler zaten kullanılıyor.');
  }

  if (code === '23514') {
    if (constraint.includes('subscriptions_status')) {
      return badRequest(res, 'Abonelik durumu geçersiz.');
    }
    return badRequest(res, 'Veri doğrulama kuralı ihlal edildi.');
  }

  if (code === '23503') {
    if (/plan/i.test(constraint + message + column)) {
      return badRequest(res, 'Starter abonelik planı bulunamadı.');
    }
    return badRequest(res, 'İlişkili kayıt bulunamadı.');
  }

  if (code === '42703' || code === '42P01') {
    return res.status(500).json({
      error: 'Veritabanı güncellemesi eksik. Migration çalıştırılmalıdır.',
      code: 'SCHEMA_OUTDATED',
    });
  }

  if (code === '22007' || code === '22008' || /date|time/i.test(message)) {
    return badRequest(res, 'Geçersiz tarih değeri.');
  }

  return null;
}

async function writeAuditTx(
  client: any,
  params: {
    actorUserId: number;
    action: string;
    entityType: string;
    entityId?: number | null;
    tenantId?: number | null;
    metadata?: unknown;
    ip?: string | null;
    userAgent?: string | null;
    before?: unknown;
    after?: unknown;
  }
) {
  const meta = params.metadata && typeof params.metadata === 'object' ? { ...params.metadata } : {};
  for (const k of Object.keys(meta as Record<string, unknown>)) {
    const key = k.toLowerCase();
    if (
      key.includes('password') ||
      key.includes('token') ||
      key.includes('secret') ||
      key.includes('authorization')
    ) {
      delete (meta as any)[k];
    }
  }
  await client.query(
    `INSERT INTO platform_audit_logs
      (actor_user_id, action, entity_type, entity_id, tenant_id, before_data, after_data, ip_address, user_agent, metadata)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10::jsonb)`,
    [
      params.actorUserId,
      params.action,
      params.entityType,
      params.entityId || null,
      params.tenantId || null,
      JSON.stringify(params.before ?? null),
      JSON.stringify(params.after ?? null),
      params.ip || null,
      params.userAgent ? String(params.userAgent).slice(0, 500) : null,
      JSON.stringify(meta),
    ]
  );
}

async function writeAudit(params: {
  actorUserId: number;
  action: string;
  entityType: string;
  entityId?: number | null;
  tenantId?: number | null;
  metadata?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  before?: unknown;
  after?: unknown;
}) {
  await writeAuditTx(pool, params);
}

function clientMeta(req: AuthRequest) {
  return {
    ip: String(req.ip || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null,
    userAgent: req.headers['user-agent'] ? String(req.headers['user-agent']) : null,
  };
}

async function deactivateExpiredTestTenants() {
  const result = await query(
    `UPDATE tenants
     SET status = 'SUSPENDED', is_active = false, updated_at = CURRENT_TIMESTAMP
     WHERE is_test_account = true
       AND expires_at IS NOT NULL
       AND expires_at < CURRENT_TIMESTAMP
       AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
     RETURNING id`
  );
  if (result.rows.length > 0) {
    await query(
      `UPDATE users SET is_active = false, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ANY($1::int[]) AND COALESCE(role,'') <> 'super_admin'`,
      [result.rows.map((r: any) => r.id)]
    );
  }
  return result.rows.length;
}

router.get('/overview', async (_req: AuthRequest, res: Response) => {
  try {
    await deactivateExpiredTestTenants();
    const [
      totals,
      users,
      recent7,
      waTenants,
      emailTenants,
      recentTenants,
      recentUsers,
      expiring,
    ] = await Promise.all([
      query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE COALESCE(status,'ACTIVE') = 'ACTIVE' AND COALESCE(is_active,true) = true)::int AS active,
           COUNT(*) FILTER (WHERE COALESCE(status,'ACTIVE') <> 'ACTIVE' OR COALESCE(is_active,true) = false)::int AS inactive
         FROM tenants`
      ),
      query(
        `SELECT
           COUNT(*) FILTER (WHERE COALESCE(role,'') <> 'super_admin')::int AS total,
           COUNT(*) FILTER (WHERE COALESCE(role,'') <> 'super_admin' AND COALESCE(is_active,true) = true)::int AS active
         FROM users`
      ),
      query(
        `SELECT COUNT(*)::int AS c FROM tenants
         WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'`
      ),
      query(
        `SELECT COUNT(DISTINCT tenant_id)::int AS c FROM channel_connections
         WHERE channel_type = 'WHATSAPP' AND status = 'ACTIVE'`
      ),
      query(
        `SELECT COUNT(DISTINCT tenant_id)::int AS c FROM mail_accounts WHERE is_active = true`
      ),
      query(
        `SELECT t.id, t.name, t.status, t.is_test_account, t.expires_at, t.created_at,
                (SELECT u.email FROM users u
                  WHERE u.tenant_id = t.id AND COALESCE(u.role,'') <> 'super_admin'
                  ORDER BY CASE u.tenant_role WHEN 'OWNER' THEN 0 ELSE 1 END, u.id LIMIT 1) AS owner_email
         FROM tenants t ORDER BY t.created_at DESC LIMIT 8`
      ),
      query(
        `SELECT u.id, u.email, u.name, u.tenant_id, u.tenant_role, u.created_at, t.name AS tenant_name
         FROM users u
         JOIN tenants t ON t.id = u.tenant_id
         WHERE COALESCE(u.role,'') <> 'super_admin'
         ORDER BY u.created_at DESC LIMIT 8`
      ),
      query(
        `SELECT id, name, expires_at, is_test_account, status
         FROM tenants
         WHERE is_test_account = true
           AND expires_at IS NOT NULL
           AND expires_at < CURRENT_TIMESTAMP + INTERVAL '7 days'
         ORDER BY expires_at ASC
         LIMIT 20`
      ),
    ]);

    res.json({
      success: true,
      data: {
        totalTenants: totals.rows[0]?.total || 0,
        activeTenants: totals.rows[0]?.active || 0,
        inactiveTenants: totals.rows[0]?.inactive || 0,
        totalUsers: users.rows[0]?.total || 0,
        activeUsers: users.rows[0]?.active || 0,
        tenantsCreatedLast7Days: recent7.rows[0]?.c || 0,
        tenantsWithWhatsApp: waTenants.rows[0]?.c || 0,
        tenantsWithEmail: emailTenants.rows[0]?.c || 0,
        recentTenants: recentTenants.rows,
        recentUsers: recentUsers.rows,
        warnings: expiring.rows.map((r: any) => ({
          type: new Date(r.expires_at) < new Date() ? 'EXPIRED_TEST_TENANT' : 'EXPIRING_TEST_TENANT',
          tenantId: r.id,
          name: r.name,
          expiresAt: r.expires_at,
          status: r.status,
        })),
      },
    });
  } catch (error) {
    console.error('Admin overview error');
    res.status(500).json({ error: 'Genel bakış alınamadı' });
  }
});

router.get('/tenants', async (req: AuthRequest, res: Response) => {
  try {
    await deactivateExpiredTestTenants();
    const q = String(req.query.q || '').trim();
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
    const offset = (page - 1) * limit;
    const params: any[] = [];
    const clauses: string[] = ['1=1'];
    if (q) {
      params.push(`%${q.replace(/[%_]/g, '')}%`);
      clauses.push(
        `(t.name ILIKE $${params.length} OR EXISTS (
           SELECT 1 FROM users u WHERE u.tenant_id = t.id AND u.email ILIKE $${params.length}
         ))`
      );
    }
    if (status === 'ACTIVE') {
      clauses.push(`COALESCE(t.status,'ACTIVE') = 'ACTIVE' AND COALESCE(t.is_active,true) = true`);
    } else if (status === 'INACTIVE' || status === 'SUSPENDED') {
      clauses.push(`(COALESCE(t.status,'ACTIVE') <> 'ACTIVE' OR COALESCE(t.is_active,true) = false)`);
    } else if (status === 'TEST') {
      clauses.push(`t.is_test_account = true`);
    }
    // Normal user-creation pickers: only real companies
    if (
      req.query.excludeTest === '1' ||
      req.query.excludeTest === 'true' ||
      req.query.forUserCreate === '1'
    ) {
      clauses.push(`COALESCE(t.is_test_account, false) = false`);
      clauses.push(
        `t.name !~* '(smoke|meta[[:space:]]*review|test[[:space:]]*tenant)'`
      );
    }

    const countRes = await query(
      `SELECT COUNT(*)::int AS c FROM tenants t WHERE ${clauses.join(' AND ')}`,
      params
    );
    params.push(limit, offset);
    const result = await query(
      `SELECT t.id, t.name, t.status, t.is_active, t.is_test_account, t.expires_at, t.admin_notes,
              t.created_at,
              (SELECT u.email FROM users u
                WHERE u.tenant_id = t.id AND COALESCE(u.role,'') <> 'super_admin'
                ORDER BY CASE u.tenant_role WHEN 'OWNER' THEN 0 ELSE 1 END, u.id LIMIT 1) AS owner_email,
              (SELECT COUNT(*)::int FROM users u
                WHERE u.tenant_id = t.id AND COALESCE(u.role,'') <> 'super_admin') AS users_count,
              (SELECT COUNT(*)::int FROM brands b WHERE b.tenant_id = t.id) AS brands_count,
              EXISTS (
                SELECT 1 FROM mail_accounts ma WHERE ma.tenant_id = t.id AND ma.is_active = true
              ) AS has_email,
              EXISTS (
                SELECT 1 FROM channel_connections cc
                WHERE cc.tenant_id = t.id AND cc.channel_type = 'WHATSAPP' AND cc.status = 'ACTIVE'
              ) AS has_whatsapp
       FROM tenants t
       WHERE ${clauses.join(' AND ')}
       ORDER BY t.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      success: true,
      data: result.rows,
      pagination: { page, limit, total: countRes.rows[0]?.c || 0 },
    });
  } catch (error) {
    console.error('Admin tenants list error');
    res.status(500).json({ error: 'Firma listesi alınamadı' });
  }
});

function slugifyName(name: string, fallback: string): string {
  const base = String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || fallback;
}

function generateTempPassword(): string {
  return `Mc${Math.random().toString(36).slice(2, 8)}9A!x`;
}

async function seedTenantBasics(
  client: any,
  tenantId: number,
  companyName: string,
  options?: {
    brandName?: string;
    planCode?: string | null;
    periodStart?: Date | null;
    periodEnd?: Date | null;
    isTrial?: boolean;
    active?: boolean;
    skipSubscription?: boolean;
    requirePlan?: boolean;
  }
) {
  const slug = `${slugifyName(companyName, 'firma')}-${tenantId}`;
  const brandIns = await client.query(
    `INSERT INTO brands (tenant_id, name, slug, is_active)
     VALUES ($1, $2, $3, true)
     RETURNING id, name, slug`,
    [tenantId, options?.brandName || companyName, slug]
  );

  try {
    await client.query(
      `INSERT INTO tags (name, color, tenant_id) VALUES
         ('teklif', '#3B82F6', $1),
         ('müşteri', '#10B981', $1),
         ('fatura', '#F59E0B', $1)`,
      [tenantId]
    );
  } catch {
    /* tags already exist or optional */
  }

  if (options?.skipSubscription) {
    return brandIns.rows[0];
  }

  await ensureTenantSubscription(client, tenantId, options);

  return brandIns.rows[0];
}

async function ensureTenantSubscription(
  client: any,
  tenantId: number,
  options?: {
    planCode?: string | null;
    periodStart?: Date | null;
    periodEnd?: Date | null;
    isTrial?: boolean;
    active?: boolean;
    requirePlan?: boolean;
  }
) {
  const existing = await client.query(
    `SELECT id FROM subscriptions WHERE tenant_id = $1 LIMIT 1`,
    [tenantId]
  );
  if (existing.rows[0]) return;

  const planCode = String(options?.planCode || 'STARTER').trim().toUpperCase();
  const plan = await client.query(
    `SELECT id, code, name FROM plans
     WHERE UPPER(COALESCE(code, name)) = $1 OR LOWER(name) = LOWER($1)
     ORDER BY id LIMIT 1`,
    [planCode]
  );
  if (!plan.rows[0]) {
    if (options?.requirePlan) {
      const err: any = new Error('PLAN_NOT_FOUND');
      err.code = 'PLAN_NOT_FOUND';
      err.planCode = planCode;
      throw err;
    }
    return;
  }

  const periodStart = options?.periodStart || new Date();
  const periodEnd =
    options?.periodEnd ||
    (() => {
      const d = new Date(periodStart);
      d.setMonth(d.getMonth() + 1);
      return d;
    })();
  const isTrial = options?.isTrial !== false;
  const subStatus = options?.active === false ? 'CANCELLED' : isTrial ? 'TRIAL' : 'ACTIVE';
  await client.query(
    `INSERT INTO subscriptions (
       tenant_id, plan_id, status, billing_period, provider,
       current_period_start, current_period_end, trial_ends_at, cancel_at_period_end
     ) VALUES ($1,$2,$3,'MONTHLY','manual',$4,$5,$6,false)`,
    [
      tenantId,
      plan.rows[0].id,
      subStatus,
      periodStart,
      periodEnd,
      isTrial ? periodEnd : null,
    ]
  );
  await client.query(
    `UPDATE tenants SET subscription_plan = LOWER(COALESCE($2, 'starter')) WHERE id = $1`,
    [tenantId, plan.rows[0].code || plan.rows[0].name || 'starter']
  );
}

router.post('/tenants', adminWriteLimiter, async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    const companyName = String(req.body?.companyName || req.body?.name || '').trim();
    const ownerName = String(req.body?.ownerName || req.body?.name || '').trim() || null;
    const ownerEmail = normalizeEmail(req.body?.ownerEmail || req.body?.email || '');
    let temporaryPassword = String(req.body?.temporaryPassword || req.body?.password || '');
    const notes = req.body?.notes || req.body?.admin_notes || null;
    // Regular company create is never a test/smoke tenant
    const isTest = false;

    if (!companyName) return badRequest(res, 'Firma adı zorunlu');
    if (!ownerEmail || !ownerEmail.includes('@')) return badRequest(res, 'İlk kullanıcı e-postası geçersiz');
    if (!temporaryPassword) temporaryPassword = generateTempPassword();
    const pwErr = validatePasswordPolicy(temporaryPassword);
    if (pwErr) return badRequest(res, pwErr);

    const existing = await client.query(`SELECT id FROM users WHERE LOWER(email) = $1`, [
      ownerEmail,
    ]);
    if (existing.rows[0]) return badRequest(res, 'Bu e-posta zaten kayıtlı');

    await client.query('BEGIN');
    const tenantIns = await client.query(
      `INSERT INTO tenants (name, status, is_active, is_test_account, expires_at, admin_notes, subscription_plan)
       VALUES ($1, 'ACTIVE', true, $2, NULL, $3, 'starter')
       RETURNING id, name, status, is_test_account, expires_at, created_at`,
      [companyName, isTest, notes ? String(notes).slice(0, 2000) : null]
    );
    const tenant = tenantIns.rows[0];
    const passwordHash = await hashPassword(temporaryPassword);
    const userIns = await client.query(
      `INSERT INTO users (email, password, tenant_id, name, role, tenant_role, is_active, permission_version)
       VALUES ($1, $2, $3, $4, 'user', 'OWNER', true, 1)
       RETURNING id, email, name, tenant_id, tenant_role, is_active, created_at`,
      [ownerEmail, passwordHash, tenant.id, ownerName]
    );
    const user = userIns.rows[0];
    const brand = await seedTenantBasics(client, tenant.id, companyName);

    await client.query('COMMIT');

    const meta = clientMeta(req);
    await writeAudit({
      actorUserId: req.user!.userId,
      action: 'TENANT_CREATED',
      entityType: 'tenant',
      entityId: tenant.id,
      tenantId: tenant.id,
      after: {
        tenantId: tenant.id,
        ownerUserId: user.id,
        ownerEmail,
        brandId: brand?.id,
        isTest: false,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    res.status(201).json({
      success: true,
      data: {
        tenant: {
          id: tenant.id,
          name: tenant.name,
          status: tenant.status,
          is_test_account: tenant.is_test_account,
          expires_at: tenant.expires_at,
          created_at: tenant.created_at,
        },
        owner: {
          id: user.id,
          email: user.email,
          name: user.name,
          tenant_role: user.tenant_role,
        },
        brand,
        // Shown once — never stored/logged again
        temporaryPassword,
      },
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    console.error('Admin create tenant error');
    res.status(500).json({ error: 'Firma oluşturulamadı' });
  } finally {
    client.release();
  }
});

/**
 * Firma kabuğu — kullanıcı olmadan tenant + varsayılan marka + temel ayarlar.
 * Abonelik ana formda uygulanır (skipSubscription).
 */
router.post('/firms', adminWriteLimiter, async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    const companyName = String(req.body?.companyName || req.body?.name || '').trim();
    const companyEmail = normalizeEmail(req.body?.companyEmail || req.body?.email || '');
    const notes = req.body?.notes || req.body?.admin_notes || null;
    const isTest = Boolean(req.body?.isTestAccount || req.body?.is_test_account);
    const expiresAt = req.body?.expiresAt || req.body?.expires_at || null;

    if (!companyName) return badRequest(res, 'Firma adı zorunlu');

    await client.query('BEGIN');
    const settingsPayload: Record<string, string> = {};
    if (companyEmail && companyEmail.includes('@')) settingsPayload.contact_email = companyEmail;
    const settings =
      Object.keys(settingsPayload).length > 0 ? JSON.stringify(settingsPayload) : null;

    const tenantIns = await client.query(
      `INSERT INTO tenants (
         name, status, is_active, is_test_account, expires_at, admin_notes,
         subscription_plan, settings
       ) VALUES (
         $1, 'ACTIVE', true, $2, $3, $4, 'starter',
         COALESCE($5::jsonb, '{}'::jsonb)
       )
       RETURNING id, name, status, is_active, is_test_account, expires_at, created_at`,
      [
        companyName,
        isTest,
        expiresAt ? new Date(expiresAt) : null,
        notes ? String(notes).slice(0, 2000) : null,
        settings,
      ]
    );
    const tenant = tenantIns.rows[0];
    if (companyEmail && companyEmail.includes('@')) {
      await client
        .query(`UPDATE tenants SET contact_email = $1 WHERE id = $2`, [companyEmail, tenant.id])
        .catch(() => undefined);
    }
    const brand = await seedTenantBasics(client, tenant.id, companyName, {
      skipSubscription: true,
      brandName: companyName,
    });
    await client.query('COMMIT');

    const meta = clientMeta(req);
    await writeAudit({
      actorUserId: req.user!.userId,
      action: 'TENANT_SHELL_CREATED',
      entityType: 'tenant',
      entityId: tenant.id,
      tenantId: tenant.id,
      after: { tenantId: tenant.id, brandId: brand?.id, companyEmail: companyEmail || null },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    res.status(201).json({
      success: true,
      data: {
        tenant: {
          id: tenant.id,
          name: tenant.name,
          status: tenant.status,
          is_active: tenant.is_active,
          is_test_account: tenant.is_test_account,
          expires_at: tenant.expires_at,
          created_at: tenant.created_at,
          users_count: 0,
        },
        brand,
      },
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    console.error('Admin create firm shell error');
    res.status(500).json({ error: 'Firma oluşturulamadı' });
  } finally {
    client.release();
  }
});

router.patch('/tenants/:id/status', adminWriteLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = Number(req.params.id);
    const active = req.body?.active === true || String(req.body?.status || '').toUpperCase() === 'ACTIVE';
    const before = await query(`SELECT id, status, is_active FROM tenants WHERE id = $1`, [
      tenantId,
    ]);
    if (!before.rows[0]) return notFound(res);
    const status = active ? 'ACTIVE' : 'SUSPENDED';
    await query(
      `UPDATE tenants SET status = $1, is_active = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
      [status, active, tenantId]
    );
    if (!active) {
      await query(
        `UPDATE users SET is_active = false, updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $1 AND COALESCE(role,'') <> 'super_admin'`,
        [tenantId]
      );
    }
    const after = await query(`SELECT id, status, is_active FROM tenants WHERE id = $1`, [
      tenantId,
    ]);
    const meta = clientMeta(req);
    await writeAudit({
      actorUserId: req.user!.userId,
      action: active ? 'TENANT_ACTIVATED' : 'TENANT_SUSPENDED',
      entityType: 'tenant',
      entityId: tenantId,
      tenantId,
      before: before.rows[0],
      after: after.rows[0],
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    res.json({ success: true, data: after.rows[0] });
  } catch (error) {
    console.error('Admin tenant status error');
    res.status(500).json({ error: 'Durum güncellenemedi' });
  }
});

router.get('/tenants/:id', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = Number(req.params.id);
    const tenant = await query(
      `SELECT id, name, status, is_active, is_test_account, expires_at, admin_notes,
              subscription_plan, created_at, updated_at, storage_used_mb
       FROM tenants WHERE id = $1`,
      [tenantId]
    );
    if (!tenant.rows[0]) return notFound(res);

    const [users, brands, channels, audits] = await Promise.all([
      query(
        `SELECT id, email, name, tenant_role, role, COALESCE(is_active,true) AS is_active,
                COALESCE(last_login_at, last_login) AS last_login_at, created_at
         FROM users WHERE tenant_id = $1 AND COALESCE(role,'') <> 'super_admin'
         ORDER BY id`,
        [tenantId]
      ),
      query(`SELECT id, name, created_at FROM brands WHERE tenant_id = $1 ORDER BY id`, [
        tenantId,
      ]),
      query(
        `SELECT id, channel_type, provider, display_name, status, settings, created_at, last_tested_at
         FROM channel_connections WHERE tenant_id = $1 ORDER BY id`,
        [tenantId]
      ),
      query(
        `SELECT id, action, entity_type, entity_id, created_at, metadata
         FROM platform_audit_logs WHERE tenant_id = $1
         ORDER BY created_at DESC LIMIT 50`,
        [tenantId]
      ),
    ]);

    const safeChannels = channels.rows.map((c: any) => ({
      id: c.id,
      channel_type: c.channel_type,
      provider: c.provider,
      display_name: c.display_name,
      status: c.status,
      phone_or_email:
        c.settings?.business_phone_number ||
        c.settings?.verified_name ||
        c.settings?.email ||
        null,
      webhook_status: c.settings?.webhook_status || null,
      created_at: c.created_at,
      last_tested_at: c.last_tested_at,
    }));

    res.json({
      success: true,
      data: {
        tenant: tenant.rows[0],
        users: users.rows.map((u: any) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          tenant_role: u.tenant_role,
          platform_role: u.role === 'super_admin' ? 'SUPER_ADMIN' : 'USER',
          is_active: u.is_active,
          last_login_at: u.last_login_at,
          created_at: u.created_at,
        })),
        brands: brands.rows,
        channels: safeChannels,
        audit: audits.rows,
      },
    });
  } catch (error) {
    console.error('Admin tenant detail error');
    res.status(500).json({ error: 'Tenant detayı alınamadı' });
  }
});

router.get('/users', async (req: AuthRequest, res: Response) => {
  try {
    const q = String(req.query.q || '').trim();
    const tenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
    const params: any[] = [];
    const clauses: string[] = [`COALESCE(u.role,'') <> 'super_admin'`];
    if (q) {
      params.push(`%${q.replace(/[%_]/g, '')}%`);
      clauses.push(`(u.email ILIKE $${params.length} OR u.name ILIKE $${params.length})`);
    }
    if (tenantId) {
      params.push(tenantId);
      clauses.push(`u.tenant_id = $${params.length}`);
    }
    const result = await query(
      `SELECT u.id, u.email, u.name, u.tenant_id, u.tenant_role, u.role,
              COALESCE(u.is_active,true) AS is_active,
              COALESCE(u.last_login_at, u.last_login) AS last_login_at,
              u.created_at, t.name AS tenant_name
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY u.created_at DESC
       LIMIT 200`,
      params
    );
    res.json({
      success: true,
      data: result.rows.map((u: any) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        tenant_id: u.tenant_id,
        tenant_name: u.tenant_name,
        tenant_role: u.tenant_role,
        platform_role: 'USER',
        is_active: u.is_active,
        last_login_at: u.last_login_at,
        created_at: u.created_at,
      })),
    });
  } catch (error) {
    console.error('Admin users list error');
    res.status(500).json({ error: 'Kullanıcı listesi alınamadı' });
  }
});

router.post('/users', adminWriteLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = Number(req.body?.tenantId || req.body?.tenant_id);
    const email = normalizeEmail(req.body?.email);
    const name = String(req.body?.name || '').trim() || null;
    const temporaryPassword = String(req.body?.temporaryPassword || req.body?.password || '');
    let tenantRole = String(req.body?.tenantRole || req.body?.tenant_role || 'MEMBER').toUpperCase();
    if (tenantRole === 'MEMBER') tenantRole = 'AGENT';
    if (!tenantId) return badRequest(res, 'Firma seçimi zorunlu');
    if (!email.includes('@')) return badRequest(res, 'E-posta geçersiz');
    const pwErr = validatePasswordPolicy(temporaryPassword);
    if (pwErr) return badRequest(res, pwErr);
    if (!isTenantRole(tenantRole)) {
      return badRequest(res, 'Firma rolü geçersiz');
    }
    // SUPER_ADMIN assignment closed in UI/API for v1
    if (String(req.body?.platformRole || '').toUpperCase() === 'SUPER_ADMIN') {
      return badRequest(res, 'Sistem yöneticisi ataması bu panelden yapılamaz');
    }

    const tenant = await query(
      `SELECT id, is_test_account FROM tenants WHERE id = $1`,
      [tenantId]
    );
    if (!tenant.rows[0]) return notFound(res);
    if (tenant.rows[0].is_test_account === true) {
      return badRequest(
        res,
        'Test / inceleme firmalarına bu ekrandan kullanıcı eklenemez'
      );
    }
    const dup = await query(`SELECT id FROM users WHERE LOWER(email) = $1`, [email]);
    if (dup.rows[0]) return badRequest(res, 'Bu e-posta zaten kayıtlı');

    const passwordHash = await hashPassword(temporaryPassword);
    const result = await query(
      `INSERT INTO users (email, password, tenant_id, name, role, tenant_role, is_active)
       VALUES ($1,$2,$3,$4,'user',$5,true)
       RETURNING id, email, name, tenant_id, tenant_role, is_active, created_at`,
      [email, passwordHash, tenantId, name, tenantRole]
    );
    const meta = clientMeta(req);
    await writeAudit({
      actorUserId: req.user!.userId,
      action: 'USER_CREATED',
      entityType: 'user',
      entityId: result.rows[0].id,
      tenantId,
      after: { email, tenantRole },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    res.status(201).json({
      success: true,
      data: {
        user: {
          ...result.rows[0],
          platform_role: 'USER',
        },
        temporaryPassword,
      },
    });
  } catch (error) {
    console.error('Admin create user error');
    res.status(500).json({ error: 'Kullanıcı oluşturulamadı' });
  }
});

router.patch('/users/:id/status', adminWriteLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const userId = Number(req.params.id);
    const active = req.body?.active === true;
    const before = await query(
      `SELECT id, email, is_active, tenant_id, role FROM users WHERE id = $1`,
      [userId]
    );
    if (!before.rows[0]) return notFound(res);
    if (before.rows[0].role === 'super_admin') {
      return badRequest(res, 'Sistem yöneticisi hesabı bu işlemle değiştirilemez');
    }
    await query(
      `UPDATE users SET is_active = $1, permission_version = COALESCE(permission_version,1)+1,
         updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [active, userId]
    );
    const meta = clientMeta(req);
    await writeAudit({
      actorUserId: req.user!.userId,
      action: active ? 'USER_ACTIVATED' : 'USER_DEACTIVATED',
      entityType: 'user',
      entityId: userId,
      tenantId: before.rows[0].tenant_id,
      before: { is_active: before.rows[0].is_active },
      after: { is_active: active },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Admin user status error');
    res.status(500).json({ error: 'Kullanıcı durumu güncellenemedi' });
  }
});

router.patch('/users/:id/role', adminWriteLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const userId = Number(req.params.id);
    let tenantRole = String(req.body?.tenantRole || req.body?.tenant_role || '').toUpperCase();
    if (tenantRole === 'MEMBER') tenantRole = 'AGENT';
    if (!isTenantRole(tenantRole)) return badRequest(res, 'Geçersiz tenant_role');
    const before = await query(
      `SELECT id, tenant_role, tenant_id, role FROM users WHERE id = $1`,
      [userId]
    );
    if (!before.rows[0]) return notFound(res);
    if (before.rows[0].role === 'super_admin') {
      return badRequest(res, 'Sistem yöneticisinin firma rolü değiştirilemez');
    }
    await query(
      `UPDATE users SET tenant_role = $1, permission_version = COALESCE(permission_version,1)+1,
         updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [tenantRole, userId]
    );
    const meta = clientMeta(req);
    await writeAudit({
      actorUserId: req.user!.userId,
      action: 'USER_ROLE_CHANGED',
      entityType: 'user',
      entityId: userId,
      tenantId: before.rows[0].tenant_id,
      before: { tenant_role: before.rows[0].tenant_role },
      after: { tenant_role: tenantRole },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Admin user role error');
    res.status(500).json({ error: 'Rol güncellenemedi' });
  }
});

router.post('/users/:id/reset-password', adminWriteLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const userId = Number(req.params.id);
    const temporaryPassword = String(req.body?.temporaryPassword || req.body?.password || '');
    const pwErr = validatePasswordPolicy(temporaryPassword);
    if (pwErr) return badRequest(res, pwErr);
    const before = await query(`SELECT id, email, tenant_id, role FROM users WHERE id = $1`, [
      userId,
    ]);
    if (!before.rows[0]) return notFound(res);
    if (before.rows[0].role === 'super_admin' && before.rows[0].id !== req.user!.userId) {
      return badRequest(res, 'Başka bir sistem yöneticisinin şifresi sıfırlanamaz');
    }
    const passwordHash = await hashPassword(temporaryPassword);
    await query(
      `UPDATE users SET password = $1, permission_version = COALESCE(permission_version,1)+1,
         updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [passwordHash, userId]
    );
    const meta = clientMeta(req);
    await writeAudit({
      actorUserId: req.user!.userId,
      action: 'USER_PASSWORD_RESET',
      entityType: 'user',
      entityId: userId,
      tenantId: before.rows[0].tenant_id,
      after: { email: before.rows[0].email },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    res.json({ success: true, data: { temporaryPassword } });
  } catch (error) {
    console.error('Admin reset password error');
    res.status(500).json({ error: 'Şifre sıfırlanamadı' });
  }
});

router.post('/review-accounts', adminWriteLimiter, async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    const companyName = String(req.body?.companyName || req.body?.name || 'Meta İnceleme').trim();
    const ownerName =
      String(req.body?.ownerName || req.body?.name || 'Meta İnceleme').trim() || 'Meta İnceleme';
    const email = normalizeEmail(req.body?.email);
    let temporaryPassword = String(req.body?.temporaryPassword || req.body?.password || '');
    const expiresAt = req.body?.expiresAt || req.body?.expires_at;
    const notes = String(req.body?.notes || 'Meta App Review inceleme hesabı').slice(0, 2000);
    if (!email.includes('@')) return badRequest(res, 'E-posta geçersiz');
    if (!temporaryPassword) temporaryPassword = generateTempPassword();
    const pwErr = validatePasswordPolicy(temporaryPassword);
    if (pwErr) return badRequest(res, pwErr);
    if (!expiresAt) return badRequest(res, 'Son kullanma tarihi zorunlu');

    const dup = await client.query(`SELECT id FROM users WHERE LOWER(email) = $1`, [email]);
    if (dup.rows[0]) return badRequest(res, 'Bu e-posta zaten kayıtlı');

    await client.query('BEGIN');
    const tenantIns = await client.query(
      `INSERT INTO tenants (name, status, is_active, is_test_account, expires_at, admin_notes, subscription_plan)
       VALUES ($1, 'ACTIVE', true, true, $2, $3, 'starter')
       RETURNING id, name, expires_at, created_at`,
      [companyName, new Date(expiresAt), notes]
    );
    const tenant = tenantIns.rows[0];
    const passwordHash = await hashPassword(temporaryPassword);
    const userIns = await client.query(
      `INSERT INTO users (email, password, tenant_id, name, role, tenant_role, is_active, permission_version)
       VALUES ($1,$2,$3,$4,'user','OWNER',true,1)
       RETURNING id, email, name, tenant_id, tenant_role, created_at`,
      [email, passwordHash, tenant.id, ownerName]
    );
    const brand = await seedTenantBasics(client, tenant.id, companyName, {
      brandName: 'Meta İnceleme Markası',
      isTrial: true,
    });
    await client.query('COMMIT');

    const meta = clientMeta(req);
    await writeAudit({
      actorUserId: req.user!.userId,
      action: 'REVIEW_ACCOUNT_CREATED',
      entityType: 'tenant',
      entityId: tenant.id,
      tenantId: tenant.id,
      after: {
        tenantId: tenant.id,
        userId: userIns.rows[0].id,
        brandId: brand?.id,
        email,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    res.status(201).json({
      success: true,
      data: {
        tenant: {
          id: tenant.id,
          name: tenant.name,
          expires_at: tenant.expires_at,
          is_test_account: true,
        },
        owner: {
          id: userIns.rows[0].id,
          email: userIns.rows[0].email,
          name: userIns.rows[0].name,
          tenant_role: userIns.rows[0].tenant_role,
        },
        brand,
        temporaryPassword,
      },
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    console.error('Admin review account error');
    res.status(500).json({ error: 'Meta inceleme hesabı oluşturulamadı' });
  } finally {
    client.release();
  }
});

router.get('/plans', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT id, COALESCE(code, UPPER(name)) AS code, display_name, name,
              COALESCE(is_active, true) AS is_active
       FROM plans
       WHERE COALESCE(is_active, true) = true
       ORDER BY id ASC`
    );
    res.json({
      success: true,
      data: result.rows.map((p: any) => ({
        id: p.id,
        code: p.code,
        name: p.display_name || p.name,
      })),
    });
  } catch (error) {
    console.error('Admin plans list error');
    res.status(500).json({ error: 'Plan listesi alınamadı' });
  }
});

/**
 * Unified account creation:
 * mode=existing → user only
 * mode=new → tenant + owner + brand + basics
 * mode=meta_review → test tenant + owner + brand
 */
router.post('/accounts', adminWriteLimiter, async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    const modeRaw = String(req.body?.mode || 'new').toLowerCase();
    const mode =
      modeRaw === 'existing' || modeRaw === 'mevcut'
        ? 'existing'
        : modeRaw === 'meta_review' || modeRaw === 'meta'
          ? 'meta_review'
          : 'new';

    const userName = String(req.body?.userName || req.body?.name || '').trim() || null;
    const userEmail = normalizeEmail(req.body?.userEmail || req.body?.email || '');
    let temporaryPassword = String(req.body?.temporaryPassword || req.body?.password || '');
    let tenantRole = String(req.body?.tenantRole || req.body?.tenant_role || 'OWNER').toUpperCase();
    if (tenantRole === 'MEMBER') tenantRole = 'AGENT';

    if (!userEmail.includes('@')) return badRequest(res, 'E-posta geçersiz');
    if (!temporaryPassword) temporaryPassword = generateTempPassword();
    const pwErr = validatePasswordPolicy(temporaryPassword);
    if (pwErr) return badRequest(res, pwErr);

    const dup = await client.query(`SELECT id FROM users WHERE LOWER(email) = $1`, [userEmail]);
    if (dup.rows[0]) return conflict(res, 'Bu e-posta adresi zaten kullanılıyor.');

    // —— Existing company: user only ——
    if (mode === 'existing') {
      const tenantId = Number(req.body?.tenantId || req.body?.tenant_id);
      if (!tenantId) return badRequest(res, 'Firma seçimi zorunlu');

      const tenant = await client.query(
        `SELECT id, name, status, is_active, is_test_account, expires_at
         FROM tenants WHERE id = $1`,
        [tenantId]
      );
      if (!tenant.rows[0]) return notFound(res);

      const userCountRes = await client.query(
        `SELECT COUNT(*)::int AS c FROM users
         WHERE tenant_id = $1 AND COALESCE(role,'') <> 'super_admin'`,
        [tenantId]
      );
      const userCount = userCountRes.rows[0]?.c || 0;
      if (userCount === 0) tenantRole = 'OWNER';
      if (!isTenantRole(tenantRole)) return badRequest(res, 'Firma rolü geçersiz');

      const planCodeRaw = req.body?.planCode || req.body?.plan;
      const periodStart = parseClientDate(req.body?.periodStart) || new Date();
      let periodEnd = parseClientDate(req.body?.periodEnd);
      if (req.body?.periodEnd && !periodEnd) return badRequest(res, 'Geçersiz abonelik bitiş tarihi.');
      if (!periodEnd) {
        periodEnd = new Date(periodStart);
        periodEnd.setMonth(periodEnd.getMonth() + 1);
      }
      const expiresParsed = parseClientDate(req.body?.expiresAt || req.body?.expires_at);
      if ((req.body?.expiresAt || req.body?.expires_at) && !expiresParsed) {
        return badRequest(res, 'Geçersiz son kullanma tarihi.');
      }

      await client.query('BEGIN');
      const passwordHash = await hashPassword(temporaryPassword);
      const userIns = await client.query(
        `INSERT INTO users (email, password, tenant_id, name, role, tenant_role, is_active, permission_version)
         VALUES ($1,$2,$3,$4,'user',$5,true,1)
         RETURNING id, email, name, tenant_id, tenant_role, is_active, created_at`,
        [userEmail, passwordHash, tenantId, userName, tenantRole]
      );

      if (planCodeRaw && userCount === 0) {
        await ensureTenantSubscription(client, tenantId, {
          planCode: String(planCodeRaw).trim().toUpperCase(),
          periodStart,
          periodEnd,
          isTrial: req.body?.isTrial !== false,
          active: true,
          requirePlan: true,
        });
      }

      if (userCount === 0 && (expiresParsed || req.body?.isTrial === true || req.body?.isDemo === true)) {
        await client.query(
          `UPDATE tenants SET
             expires_at = COALESCE($2::timestamptz, expires_at),
             updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [tenantId, expiresParsed]
        );
      }

      const meta = clientMeta(req);
      await writeAuditTx(client, {
        actorUserId: req.user!.userId,
        action: 'USER_CREATED',
        entityType: 'user',
        entityId: userIns.rows[0].id,
        tenantId,
        after: { email: userEmail, tenantRole },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });

      await client.query('COMMIT');

      return res.status(201).json({
        success: true,
        data: {
          mode: 'existing',
          tenant: {
            id: tenant.rows[0].id,
            name: tenant.rows[0].name,
            status: tenant.rows[0].status,
            expires_at: expiresParsed || tenant.rows[0].expires_at,
          },
          user: {
            id: userIns.rows[0].id,
            email: userIns.rows[0].email,
            name: userIns.rows[0].name,
            tenant_role: userIns.rows[0].tenant_role,
          },
          temporaryPassword,
        },
      });
    }

    // —— New company or Meta review ——
    const isMeta = mode === 'meta_review';
    const companyName = String(
      req.body?.companyName || req.body?.name || (isMeta ? 'Meta Review' : '')
    ).trim();
    const companyEmail = normalizeEmail(
      req.body?.companyEmail || req.body?.email || req.body?.userEmail || ''
    );
    const companyPhone = String(req.body?.phone || req.body?.companyPhone || '').trim() || null;
    const isDemo = Boolean(req.body?.isDemo || req.body?.is_demo);
    const demoDays = Math.max(0, Number(req.body?.demoDays || req.body?.demo_days || 0) || 0);
    const isTest = isMeta || Boolean(req.body?.isTestAccount || req.body?.is_test_account);
    const notes = req.body?.notes || req.body?.admin_notes || null;
    const planCode = String(req.body?.planCode || req.body?.plan || 'STARTER').trim().toUpperCase();

    let expiresAtDate = parseClientDate(req.body?.expiresAt || req.body?.expires_at);
    if ((req.body?.expiresAt || req.body?.expires_at) && !expiresAtDate) {
      return badRequest(res, 'Geçersiz son kullanma tarihi.');
    }
    if (!expiresAtDate && (isDemo || isMeta) && demoDays > 0) {
      expiresAtDate = new Date();
      expiresAtDate.setDate(expiresAtDate.getDate() + demoDays);
    } else if (!expiresAtDate && isMeta) {
      expiresAtDate = new Date();
      expiresAtDate.setDate(expiresAtDate.getDate() + 14);
    }

    const periodStart = parseClientDate(req.body?.periodStart) || new Date();
    let periodEnd = parseClientDate(req.body?.periodEnd);
    if (req.body?.periodEnd && !periodEnd) {
      return badRequest(res, 'Geçersiz abonelik bitiş tarihi.');
    }
    if (!periodEnd) {
      periodEnd = new Date(periodStart);
      if (isDemo && demoDays > 0) periodEnd.setDate(periodEnd.getDate() + demoDays);
      else if (expiresAtDate) periodEnd = new Date(expiresAtDate);
      else periodEnd.setMonth(periodEnd.getMonth() + 1);
    }

    const isTrial = req.body?.isTrial !== false || isDemo || isMeta;
    const active = req.body?.active !== false;

    if (!companyName) return badRequest(res, 'Firma adı zorunlu');
    if (isMeta && !expiresAtDate) return badRequest(res, 'Son kullanma tarihi zorunlu');
    if (isDemo && demoDays <= 0 && !expiresAtDate) {
      return badRequest(res, 'Demo süresi (gün) zorunlu');
    }

    // Validate plan exists before opening transaction
    const planCheck = await client.query(
      `SELECT id, code, name FROM plans
       WHERE UPPER(COALESCE(code, name)) = $1 OR LOWER(name) = LOWER($1)
       ORDER BY id LIMIT 1`,
      [planCode]
    );
    if (!planCheck.rows[0]) {
      return badRequest(res, `${planCode} abonelik planı bulunamadı.`);
    }

    tenantRole = 'OWNER';

    await client.query('BEGIN');
    const settingsPayload: Record<string, string> = {};
    if (companyEmail && companyEmail.includes('@')) settingsPayload.contact_email = companyEmail;
    if (companyPhone) settingsPayload.contact_phone = companyPhone;
    const settings =
      Object.keys(settingsPayload).length > 0 ? JSON.stringify(settingsPayload) : null;

    const tenantIns = await client.query(
      `INSERT INTO tenants (
         name, status, is_active, is_test_account, expires_at, admin_notes,
         subscription_plan, settings
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, COALESCE($8::jsonb, '{}'::jsonb)
       )
       RETURNING id, name, status, is_active, is_test_account, expires_at, created_at`,
      [
        companyName,
        active ? 'ACTIVE' : 'SUSPENDED',
        active,
        isTest,
        expiresAtDate,
        notes ? String(notes).slice(0, 2000) : isMeta ? 'Meta App Review inceleme hesabı' : null,
        planCode.toLowerCase(),
        settings,
      ]
    );
    const tenant = tenantIns.rows[0];
    if (companyEmail && companyEmail.includes('@')) {
      await client.query(`UPDATE tenants SET contact_email = $1 WHERE id = $2`, [
        companyEmail,
        tenant.id,
      ]);
    }

    const passwordHash = await hashPassword(temporaryPassword);
    const userIns = await client.query(
      `INSERT INTO users (email, password, tenant_id, name, role, tenant_role, is_active, permission_version)
       VALUES ($1,$2,$3,$4,'user','OWNER',true,1)
       RETURNING id, email, name, tenant_id, tenant_role, is_active, created_at`,
      [userEmail, passwordHash, tenant.id, userName || (isMeta ? 'Meta Review' : null)]
    );

    const brand = await seedTenantBasics(client, tenant.id, companyName, {
      brandName: isMeta ? 'Meta Review' : companyName,
      planCode,
      periodStart,
      periodEnd,
      isTrial,
      active,
      requirePlan: true,
    });

    const meta = clientMeta(req);
    await writeAuditTx(client, {
      actorUserId: req.user!.userId,
      action: isMeta ? 'REVIEW_ACCOUNT_CREATED' : 'TENANT_CREATED',
      entityType: 'tenant',
      entityId: tenant.id,
      tenantId: tenant.id,
      after: {
        tenantId: tenant.id,
        userId: userIns.rows[0].id,
        brandId: brand?.id,
        email: userEmail,
        isTest,
        mode,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    await client.query('COMMIT');

    return res.status(201).json({
      success: true,
      data: {
        mode,
        tenant: {
          id: tenant.id,
          name: tenant.name,
          status: tenant.status,
          is_test_account: tenant.is_test_account,
          expires_at: tenant.expires_at,
        },
        user: {
          id: userIns.rows[0].id,
          email: userIns.rows[0].email,
          name: userIns.rows[0].name,
          tenant_role: userIns.rows[0].tenant_role,
        },
        brand,
        temporaryPassword,
      },
    });
  } catch (error: any) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    if (error?.code === 'PLAN_NOT_FOUND') {
      return badRequest(res, `${error.planCode || 'Seçilen'} abonelik planı bulunamadı.`);
    }
    logAccountCreateError(error, 'POST /accounts');
    const mapped = mapAccountCreateDbError(res, error);
    if (mapped) return mapped;
    return res.status(500).json({
      error: 'Hesap oluşturulamadı. Sunucu kaydı incelensin.',
      code: 'ACCOUNT_CREATE_FAILED',
    });
  } finally {
    client.release();
  }
});

router.get('/audit', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
    const params: any[] = [];
    let sql = `SELECT id, actor_user_id, action, entity_type, entity_id, tenant_id,
                      created_at, ip_address, metadata
               FROM platform_audit_logs`;
    if (tenantId) {
      params.push(tenantId);
      sql += ` WHERE tenant_id = $1`;
    }
    sql += ` ORDER BY created_at DESC LIMIT 100`;
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Admin audit list error');
    res.status(500).json({ error: 'Audit listesi alınamadı' });
  }
});

export default router;
