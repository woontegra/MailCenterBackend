/**
 * Additional SUPER_ADMIN control-center modules under /api/admin-platform/*
 */
import { Router, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { authenticate, AuthRequest, requireSuperAdmin } from '../middleware/auth';
import { query } from '../config/database';
import { badRequest, notFound } from '../utils/channelPlatform';
import { pingRedis, getRedisStatusSnapshot } from '../config/redis';
import { getMailSendQueueCounts, mailFetchQueue, mailSendQueue } from '../queues/mailQueue';

const router = Router();
router.use(authenticate);
router.use(requireSuperAdmin);

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 80,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Çok fazla işlem. Lütfen sonra tekrar deneyin.' },
});

function clientMeta(req: AuthRequest) {
  return {
    ip: String(req.ip || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null,
    userAgent: req.headers['user-agent'] ? String(req.headers['user-agent']) : null,
  };
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
}) {
  const meta =
    params.metadata && typeof params.metadata === 'object' ? { ...(params.metadata as object) } : {};
  await query(
    `INSERT INTO platform_audit_logs
      (actor_user_id, action, entity_type, entity_id, tenant_id, before_data, after_data, ip_address, user_agent, metadata)
     VALUES ($1,$2,$3,$4,$5,NULL,NULL,$6,$7,$8::jsonb)`,
    [
      params.actorUserId,
      params.action,
      params.entityType,
      params.entityId || null,
      params.tenantId || null,
      params.ip || null,
      params.userAgent ? String(params.userAgent).slice(0, 500) : null,
      JSON.stringify(meta),
    ]
  );
}

/** Expanded control-center dashboard */
router.get('/control-center', async (_req: AuthRequest, res: Response) => {
  try {
    const [
      tenants,
      users,
      channels,
      mailAccounts,
      outbound24,
      supportOpen,
      critical,
      trial,
      expired,
      todayTenants,
      recentTenants,
      recentUsers,
      recentLogins,
      recentAudit,
      brands,
      licenses,
      subscriptions,
      channelTotal,
    ] = await Promise.all([
      query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE COALESCE(status,'ACTIVE')='ACTIVE' AND COALESCE(is_active,true) = true)::int AS active,
           COUNT(*) FILTER (WHERE COALESCE(status,'ACTIVE')<>'ACTIVE' OR COALESCE(is_active,true) = false)::int AS inactive
         FROM tenants`
      ),
      query(
        `SELECT
           COUNT(*) FILTER (WHERE COALESCE(role,'')<>'super_admin')::int AS total,
           COUNT(*) FILTER (WHERE COALESCE(role,'')<>'super_admin' AND COALESCE(is_active,true) = true)::int AS active,
           COUNT(*) FILTER (WHERE COALESCE(role,'')<>'super_admin' AND COALESCE(is_active,true) = false)::int AS inactive
         FROM users`
      ),
      query(
        `SELECT
           COUNT(*) FILTER (WHERE channel_type='WHATSAPP' AND status='ACTIVE')::int AS whatsapp,
           COUNT(*) FILTER (WHERE channel_type='SMS' AND status='ACTIVE')::int AS sms,
           COUNT(*) FILTER (WHERE status='ACTIVE')::int AS active,
           COUNT(*)::int AS total
         FROM channel_connections`
      ),
      query(`SELECT COUNT(*)::int AS c FROM mail_accounts WHERE COALESCE(is_active,true)=true`),
      query(
        `SELECT
           COUNT(*) FILTER (WHERE channel_type='EMAIL' OR channel_type IS NULL OR channel_type='MAIL')::int AS mail,
           COUNT(*) FILTER (WHERE channel_type='WHATSAPP')::int AS whatsapp,
           COUNT(*) FILTER (WHERE channel_type='SMS')::int AS sms
         FROM outbound_messages
         WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours'`
      ).catch(() => ({ rows: [{ mail: 0, whatsapp: 0, sms: 0 }] })),
      query(
        `SELECT COUNT(*)::int AS c FROM platform_support_tickets
         WHERE status IN ('OPEN','IN_PROGRESS','WAITING')`
      ).catch(() => ({ rows: [{ c: 0 }] })),
      query(
        `SELECT COUNT(*)::int AS c FROM channel_connections WHERE status='ERROR'`
      ),
      query(
        `SELECT COUNT(*)::int AS c FROM tenants
         WHERE is_test_account=true OR COALESCE(subscription_plan,'') ILIKE '%trial%'
            OR EXISTS (
              SELECT 1 FROM subscriptions s
              WHERE s.tenant_id = tenants.id AND UPPER(COALESCE(s.status,'')) IN ('TRIAL','TRIALING')
            )`
      ),
      query(
        `SELECT COUNT(*)::int AS c FROM tenants
         WHERE expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP`
      ),
      query(
        `SELECT COUNT(*)::int AS c FROM tenants
         WHERE created_at >= CURRENT_DATE`
      ),
      query(
        `SELECT t.id, t.name, t.created_at, t.status, t.is_test_account
         FROM tenants t ORDER BY t.created_at DESC LIMIT 10`
      ),
      query(
        `SELECT u.id, u.email, u.name, u.created_at, t.name AS tenant_name
         FROM users u JOIN tenants t ON t.id=u.tenant_id
         WHERE COALESCE(u.role,'')<>'super_admin'
         ORDER BY u.created_at DESC LIMIT 10`
      ),
      query(
        `SELECT u.id, u.email, u.name, COALESCE(u.last_login_at, u.last_login) AS last_login_at, t.name AS tenant_name
         FROM users u JOIN tenants t ON t.id=u.tenant_id
         WHERE COALESCE(u.role,'')<>'super_admin'
           AND COALESCE(u.last_login_at, u.last_login) IS NOT NULL
         ORDER BY COALESCE(u.last_login_at, u.last_login) DESC NULLS LAST
         LIMIT 10`
      ).catch(() => ({ rows: [] })),
      query(
        `SELECT id, actor_user_id, action, entity_type, entity_id, tenant_id, created_at, ip_address
         FROM platform_audit_logs ORDER BY created_at DESC LIMIT 15`
      ),
      query(`SELECT COUNT(*)::int AS c FROM brands`).catch(() => ({ rows: [{ c: 0 }] })),
      query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status='ACTIVE')::int AS active,
           COUNT(*) FILTER (WHERE status='REVOKED')::int AS revoked
         FROM platform_licenses`
      ).catch(() => ({ rows: [{ total: 0, active: 0, revoked: 0 }] })),
      query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE UPPER(COALESCE(status,'')) IN ('ACTIVE','TRIAL'))::int AS active,
           COUNT(*) FILTER (WHERE UPPER(COALESCE(status,'')) IN ('CANCELLED','CANCELED'))::int AS cancelled
         FROM subscriptions`
      ).catch(() => ({ rows: [{ total: 0, active: 0, cancelled: 0 }] })),
      query(
        `SELECT COUNT(*)::int AS c FROM channel_connections`
      ).catch(() => ({ rows: [{ c: 0 }] })),
    ]);

    let queueWaiting = 0;
    let queueFailed = 0;
    try {
      const counts = await getMailSendQueueCounts();
      queueWaiting = Number(counts.waiting || 0) + Number(counts.delayed || 0);
      queueFailed = Number(counts.failed || 0);
    } catch {
      /* ignore */
    }

    const sessions = await query(
      `SELECT COUNT(*)::int AS c FROM user_sessions
       WHERE COALESCE(is_active,true)=true
         AND COALESCE(expires_at, CURRENT_TIMESTAMP + INTERVAL '1 day') > CURRENT_TIMESTAMP`
    ).catch(() => ({ rows: [{ c: 0 }] }));

    const auditCount = await query(
      `SELECT COUNT(*)::int AS c FROM platform_audit_logs`
    ).catch(() => ({ rows: [{ c: 0 }] }));

    const ob = outbound24.rows[0] || {};
    const hub = {
      control: {
        firms: tenants.rows[0]?.total || 0,
        users: users.rows[0]?.total || 0,
        errors: critical.rows[0]?.c || 0,
      },
      firms: {
        total: tenants.rows[0]?.total || 0,
        active: tenants.rows[0]?.active || 0,
        trial: trial.rows[0]?.c || 0,
        inactive: tenants.rows[0]?.inactive || 0,
      },
      users: {
        total: users.rows[0]?.total || 0,
        active: users.rows[0]?.active || 0,
        inactive: users.rows[0]?.inactive || 0,
      },
      createFirm: {
        today: todayTenants.rows[0]?.c || 0,
        trial: trial.rows[0]?.c || 0,
      },
      subscriptions: {
        total: subscriptions.rows[0]?.total || 0,
        active: subscriptions.rows[0]?.active || 0,
        cancelled: subscriptions.rows[0]?.cancelled || 0,
      },
      licenses: {
        total: licenses.rows[0]?.total || 0,
        active: licenses.rows[0]?.active || 0,
        revoked: licenses.rows[0]?.revoked || 0,
      },
      channels: {
        total: channels.rows[0]?.total || channelTotal.rows[0]?.c || 0,
        active: channels.rows[0]?.active || 0,
        whatsapp: channels.rows[0]?.whatsapp || 0,
        sms: channels.rows[0]?.sms || 0,
      },
      brands: {
        total: brands.rows[0]?.c || 0,
      },
      mailAccounts: {
        total: mailAccounts.rows[0]?.c || 0,
      },
      whatsapp: {
        connections: channels.rows[0]?.whatsapp || 0,
        sent24h: Number(ob.whatsapp || 0),
      },
      queues: {
        waiting: queueWaiting,
        failed: queueFailed,
        sent24h: Number(ob.mail || 0) + Number(ob.whatsapp || 0) + Number(ob.sms || 0),
      },
      support: {
        open: supportOpen.rows[0]?.c || 0,
      },
      health: {
        errors: critical.rows[0]?.c || 0,
        db: 'ok',
      },
      audit: {
        total: auditCount.rows[0]?.c || 0,
        recent: recentAudit.rows.length,
      },
      logs: {
        recent: recentAudit.rows.length,
      },
      security: {
        sessions: sessions.rows[0]?.c || 0,
        errors: critical.rows[0]?.c || 0,
      },
    };

    res.json({
      success: true,
      data: {
        hub,
        totalTenants: tenants.rows[0]?.total || 0,
        activeTenants: tenants.rows[0]?.active || 0,
        inactiveTenants: tenants.rows[0]?.inactive || 0,
        trialAccounts: trial.rows[0]?.c || 0,
        expiredAccounts: expired.rows[0]?.c || 0,
        tenantsCreatedToday: todayTenants.rows[0]?.c || 0,
        totalUsers: users.rows[0]?.total || 0,
        activeUsers: users.rows[0]?.active || 0,
        mailAccountCount: mailAccounts.rows[0]?.c || 0,
        whatsappChannelCount: channels.rows[0]?.whatsapp || 0,
        smsChannelCount: channels.rows[0]?.sms || 0,
        mailSent24h: Number(ob.mail || 0),
        whatsappSent24h: Number(ob.whatsapp || 0),
        smsSent24h: Number(ob.sms || 0),
        openSupportTickets: supportOpen.rows[0]?.c || 0,
        criticalSystemErrors: critical.rows[0]?.c || 0,
        recentTenants: recentTenants.rows,
        recentUsers: recentUsers.rows,
        recentLogins: recentLogins.rows || [],
        recentAudit: recentAudit.rows,
        systemEvents: recentAudit.rows.slice(0, 8).map((a: any) => ({
          id: a.id,
          label: a.action,
          at: a.created_at,
          tenantId: a.tenant_id,
        })),
      },
    });
  } catch (error) {
    console.error('Control center error', error);
    res.status(500).json({ error: 'Kontrol merkezi yüklenemedi' });
  }
});

/** Tenant soft delete / extend / test flag */
router.patch('/tenants/:id', writeLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const before = await query(`SELECT * FROM tenants WHERE id = $1`, [id]);
    if (!before.rows[0]) return notFound(res);

    const sets: string[] = [];
    const params: any[] = [];
    const body = req.body || {};

    if (body.isTestAccount != null || body.is_test_account != null) {
      params.push(Boolean(body.isTestAccount ?? body.is_test_account));
      sets.push(`is_test_account = $${params.length}`);
    }
    if (body.expiresAt !== undefined || body.expires_at !== undefined) {
      const v = body.expiresAt ?? body.expires_at;
      params.push(v ? new Date(v) : null);
      sets.push(`expires_at = $${params.length}`);
    }
    if (body.adminNotes !== undefined || body.admin_notes !== undefined) {
      params.push(String(body.adminNotes ?? body.admin_notes ?? '').slice(0, 4000));
      sets.push(`admin_notes = $${params.length}`);
    }
    if (body.extendDays) {
      const days = Math.max(1, Math.min(365, Number(body.extendDays)));
      sets.push(
        `expires_at = COALESCE(expires_at, CURRENT_TIMESTAMP) + INTERVAL '${days} days'`
      );
    }
    if (body.archive === true || body.delete === true) {
      sets.push(`status = 'ARCHIVED'`);
      sets.push(`is_active = false`);
    }
    if (!sets.length) return badRequest(res, 'Güncellenecek alan yok');
    sets.push(`updated_at = CURRENT_TIMESTAMP`);
    params.push(id);
    const after = await query(
      `UPDATE tenants SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    const meta = clientMeta(req);
    await writeAudit({
      actorUserId: req.user!.userId,
      action: body.delete || body.archive ? 'TENANT_ARCHIVED' : 'TENANT_UPDATED',
      entityType: 'tenant',
      entityId: id,
      tenantId: id,
      metadata: { fields: Object.keys(body) },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    res.json({ success: true, data: after.rows[0] });
  } catch (error) {
    console.error('Tenant patch error');
    res.status(500).json({ error: 'Firma güncellenemedi' });
  }
});

router.get('/subscriptions', async (req: AuthRequest, res: Response) => {
  try {
    const q = String(req.query.q || '').trim();
    const params: any[] = [];
    let where = '1=1';
    if (q) {
      params.push(`%${q.replace(/[%_]/g, '')}%`);
      where += ` AND (t.name ILIKE $${params.length} OR p.display_name ILIKE $${params.length} OR p.name ILIKE $${params.length})`;
    }
    const result = await query(
      `SELECT s.id, s.tenant_id, s.status, s.current_period_start, s.current_period_end,
              s.trial_ends_at, s.cancel_at_period_end, s.created_at,
              t.name AS tenant_name, t.is_test_account,
              COALESCE(p.display_name, p.name, p.code) AS plan_name, p.code AS plan_code
       FROM subscriptions s
       JOIN tenants t ON t.id = s.tenant_id
       LEFT JOIN plans p ON p.id = s.plan_id
       WHERE ${where}
       ORDER BY s.created_at DESC
       LIMIT 200`,
      params
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Subscriptions list error');
    res.status(500).json({ error: 'Abonelik listesi alınamadı' });
  }
});

router.patch('/subscriptions/:id', writeLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const before = await query(`SELECT * FROM subscriptions WHERE id = $1`, [id]);
    if (!before.rows[0]) return notFound(res);
    const sets: string[] = [];
    const params: any[] = [];
    if (req.body?.status) {
      params.push(String(req.body.status));
      sets.push(`status = $${params.length}`);
    }
    if (req.body?.periodEnd || req.body?.current_period_end) {
      params.push(new Date(req.body.periodEnd || req.body.current_period_end));
      sets.push(`current_period_end = $${params.length}`);
    }
    if (req.body?.extendDays) {
      const days = Math.max(1, Math.min(365, Number(req.body.extendDays)));
      sets.push(
        `current_period_end = COALESCE(current_period_end, CURRENT_TIMESTAMP) + INTERVAL '${days} days'`
      );
    }
    if (req.body?.cancel === true) {
      sets.push(`cancel_at_period_end = true`);
      params.push('CANCELLED');
      sets.push(`status = $${params.length}`);
    }
    if (req.body?.suspend === true) {
      params.push('PAST_DUE');
      sets.push(`status = $${params.length}`);
    }
    if (req.body?.notes) {
      // store note in audit only
    }
    if (!sets.length) return badRequest(res, 'Güncellenecek alan yok');
    params.push(id);
    const after = await query(
      `UPDATE subscriptions SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $${params.length} RETURNING *`,
      params
    );
    const meta = clientMeta(req);
    await writeAudit({
      actorUserId: req.user!.userId,
      action: 'SUBSCRIPTION_UPDATED',
      entityType: 'subscription',
      entityId: id,
      tenantId: before.rows[0].tenant_id,
      metadata: { note: req.body?.notes ? String(req.body.notes).slice(0, 500) : undefined },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    res.json({ success: true, data: after.rows[0] });
  } catch (error) {
    console.error('Subscription patch error');
    res.status(500).json({ error: 'Abonelik güncellenemedi' });
  }
});

router.get('/licenses', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT l.*, t.name AS tenant_name
       FROM platform_licenses l
       LEFT JOIN tenants t ON t.id = l.tenant_id
       ORDER BY l.created_at DESC LIMIT 200`
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Lisans listesi alınamadı' });
  }
});

router.post('/licenses', writeLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.body?.tenantId ? Number(req.body.tenantId) : null;
    const expiresAt = req.body?.expiresAt ? new Date(req.body.expiresAt) : null;
    const notes = req.body?.notes ? String(req.body.notes).slice(0, 2000) : null;
    const licenseKey = `MC-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
    const ins = await query(
      `INSERT INTO platform_licenses (tenant_id, license_key, status, starts_at, expires_at, notes, created_by)
       VALUES ($1,$2,'ACTIVE',CURRENT_TIMESTAMP,$3,$4,$5)
       RETURNING *`,
      [tenantId, licenseKey, expiresAt, notes, req.user!.userId]
    );
    await query(
      `INSERT INTO platform_license_events (license_id, actor_user_id, action, metadata)
       VALUES ($1,$2,'CREATED',$3::jsonb)`,
      [ins.rows[0].id, req.user!.userId, JSON.stringify({ tenantId })]
    );
    res.status(201).json({ success: true, data: ins.rows[0] });
  } catch (error) {
    console.error('License create error');
    res.status(500).json({ error: 'Lisans oluşturulamadı' });
  }
});

router.patch('/licenses/:id', writeLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const before = await query(`SELECT * FROM platform_licenses WHERE id = $1`, [id]);
    if (!before.rows[0]) return notFound(res);
    if (req.body?.revoke === true) {
      await query(
        `UPDATE platform_licenses SET status='REVOKED', updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
        [id]
      );
      await query(
        `INSERT INTO platform_license_events (license_id, actor_user_id, action) VALUES ($1,$2,'REVOKED')`,
        [id, req.user!.userId]
      );
    } else if (req.body?.extendDays) {
      const days = Math.max(1, Math.min(730, Number(req.body.extendDays)));
      await query(
        `UPDATE platform_licenses
         SET expires_at = COALESCE(expires_at, CURRENT_TIMESTAMP) + INTERVAL '${days} days',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [id]
      );
      await query(
        `INSERT INTO platform_license_events (license_id, actor_user_id, action, metadata)
         VALUES ($1,$2,'EXTENDED',$3::jsonb)`,
        [id, req.user!.userId, JSON.stringify({ days })]
      );
    }
    const after = await query(`SELECT * FROM platform_licenses WHERE id = $1`, [id]);
    res.json({ success: true, data: after.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Lisans güncellenemedi' });
  }
});

router.get('/licenses/:id/events', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT * FROM platform_license_events WHERE license_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [Number(req.params.id)]
    );
    res.json({ success: true, data: result.rows });
  } catch {
    res.status(500).json({ error: 'Lisans geçmişi alınamadı' });
  }
});

router.get('/support-tickets', async (req: AuthRequest, res: Response) => {
  try {
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    const params: any[] = [];
    let where = '1=1';
    if (status) {
      params.push(status);
      where += ` AND t.status = $${params.length}`;
    }
    const result = await query(
      `SELECT t.*, tn.name AS tenant_name, u.email AS user_email, a.email AS assignee_email
       FROM platform_support_tickets t
       LEFT JOIN tenants tn ON tn.id = t.tenant_id
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN users a ON a.id = t.assigned_to
       WHERE ${where}
       ORDER BY t.updated_at DESC NULLS LAST, t.created_at DESC
       LIMIT 200`,
      params
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Destek listesi alınamadı' });
  }
});

router.post('/support-tickets', writeLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const subject = String(req.body?.subject || '').trim();
    if (!subject) return badRequest(res, 'Konu zorunlu');
    const ins = await query(
      `INSERT INTO platform_support_tickets
        (tenant_id, user_id, assigned_to, subject, status, priority, body)
       VALUES ($1,$2,$3,$4,COALESCE($5,'OPEN'),COALESCE($6,'NORMAL'),$7)
       RETURNING *`,
      [
        req.body?.tenantId ? Number(req.body.tenantId) : null,
        req.body?.userId ? Number(req.body.userId) : null,
        req.body?.assignedTo ? Number(req.body.assignedTo) : null,
        subject,
        req.body?.status || 'OPEN',
        String(req.body?.priority || 'NORMAL').toUpperCase(),
        req.body?.body ? String(req.body.body).slice(0, 8000) : null,
      ]
    );
    res.status(201).json({ success: true, data: ins.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Destek talebi oluşturulamadı' });
  }
});

router.patch('/support-tickets/:id', writeLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const before = await query(`SELECT * FROM platform_support_tickets WHERE id = $1`, [id]);
    if (!before.rows[0]) return notFound(res);
    const sets: string[] = ['updated_at = CURRENT_TIMESTAMP'];
    const params: any[] = [];
    for (const [key, col] of [
      ['status', 'status'],
      ['priority', 'priority'],
      ['resolutionNote', 'resolution_note'],
      ['assignedTo', 'assigned_to'],
    ] as const) {
      if (req.body?.[key] !== undefined) {
        params.push(req.body[key]);
        sets.push(`${col} = $${params.length}`);
      }
    }
    if (String(req.body?.status || '').toUpperCase() === 'RESOLVED') {
      sets.push(`closed_at = CURRENT_TIMESTAMP`);
    }
    params.push(id);
    const after = await query(
      `UPDATE platform_support_tickets SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (req.body?.internalNote) {
      await query(
        `INSERT INTO platform_support_messages (ticket_id, author_user_id, is_internal, body)
         VALUES ($1,$2,true,$3)`,
        [id, req.user!.userId, String(req.body.internalNote).slice(0, 8000)]
      );
    }
    res.json({ success: true, data: after.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Destek talebi güncellenemedi' });
  }
});

router.get('/support-tickets/:id/messages', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT m.*, u.email AS author_email
       FROM platform_support_messages m
       LEFT JOIN users u ON u.id = m.author_user_id
       WHERE m.ticket_id = $1 ORDER BY m.created_at ASC`,
      [Number(req.params.id)]
    );
    res.json({ success: true, data: result.rows });
  } catch {
    res.status(500).json({ error: 'Mesajlar alınamadı' });
  }
});

router.get('/live-chat', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT c.id, c.tenant_id, c.status, c.channel_type, c.updated_at, c.created_at,
              t.name AS tenant_name,
              (SELECT COUNT(*)::int FROM conversation_messages cm WHERE cm.conversation_id = c.id) AS message_count
       FROM conversations c
       JOIN tenants t ON t.id = c.tenant_id
       WHERE COALESCE(c.status,'OPEN') IN ('OPEN','PENDING','WAITING','ACTIVE')
       ORDER BY c.updated_at DESC NULLS LAST
       LIMIT 100`
    ).catch(() => ({ rows: [] }));
    const online = await query(
      `SELECT COUNT(DISTINCT user_id)::int AS c FROM user_sessions
       WHERE COALESCE(is_active,true)=true
         AND COALESCE(last_activity_at, created_at) > CURRENT_TIMESTAMP - INTERVAL '15 minutes'`
    ).catch(() => ({ rows: [{ c: 0 }] }));
    res.json({
      success: true,
      data: {
        conversations: result.rows,
        waiting: result.rows.filter((r: any) =>
          ['PENDING', 'WAITING'].includes(String(r.status || '').toUpperCase())
        ).length,
        onlineUsers: online.rows[0]?.c || 0,
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'Canlı sohbet verisi alınamadı' });
  }
});

router.get('/send-stats', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT
         DATE(created_at) AS day,
         COUNT(*) FILTER (WHERE channel_type='EMAIL' OR channel_type IS NULL OR channel_type='MAIL')::int AS mail,
         COUNT(*) FILTER (WHERE channel_type='WHATSAPP')::int AS whatsapp,
         COUNT(*) FILTER (WHERE channel_type='SMS')::int AS sms,
         COUNT(*) FILTER (WHERE UPPER(COALESCE(status,'')) IN ('SENT','DELIVERED','SUCCESS'))::int AS success,
         COUNT(*) FILTER (WHERE UPPER(COALESCE(status,'')) IN ('FAILED','ERROR','BOUNCED'))::int AS failed,
         COUNT(*) FILTER (WHERE UPPER(COALESCE(status,'')) IN ('PENDING','QUEUED','PROCESSING'))::int AS pending
       FROM outbound_messages
       WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days'
       GROUP BY DATE(created_at)
       ORDER BY day ASC`
    ).catch(() => ({ rows: [] }));
    const totals = await query(
      `SELECT
         COUNT(*) FILTER (WHERE UPPER(COALESCE(status,'')) IN ('SENT','DELIVERED','SUCCESS'))::int AS success,
         COUNT(*) FILTER (WHERE UPPER(COALESCE(status,'')) IN ('FAILED','ERROR','BOUNCED'))::int AS failed,
         COUNT(*) FILTER (WHERE UPPER(COALESCE(status,'')) IN ('PENDING','QUEUED','PROCESSING'))::int AS pending,
         COUNT(*) FILTER (WHERE channel_type='EMAIL' OR channel_type IS NULL OR channel_type='MAIL')::int AS mail,
         COUNT(*) FILTER (WHERE channel_type='WHATSAPP')::int AS whatsapp,
         COUNT(*) FILTER (WHERE channel_type='SMS')::int AS sms
       FROM outbound_messages
       WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days'`
    ).catch(() => ({ rows: [{}] }));
    res.json({ success: true, data: { days: result.rows, totals: totals.rows[0] || {} } });
  } catch (error) {
    res.status(500).json({ error: 'Gönderim istatistikleri alınamadı' });
  }
});

router.get('/system-health', async (_req: AuthRequest, res: Response) => {
  try {
    let database: 'ok' | 'error' = 'error';
    try {
      await query('SELECT 1');
      database = 'ok';
    } catch {
      database = 'error';
    }
    const redisPing = await pingRedis();
    const redisSnapshot = getRedisStatusSnapshot();
    let queueCounts: any = null;
    try {
      queueCounts = await getMailSendQueueCounts();
    } catch {
      queueCounts = null;
    }
    const mem = process.memoryUsage();
    res.json({
      success: true,
      data: {
        api: 'ok',
        database,
        redis: redisPing.ok ? 'ok' : 'error',
        queue: redisSnapshot.queueEnabled
          ? redisPing.ok
            ? 'ok'
            : 'error'
          : 'disabled',
        mailWorker: queueCounts ? 'ok' : redisSnapshot.queueEnabled ? 'unknown' : 'disabled',
        whatsappWorker: 'unknown',
        disk: 'unknown',
        ram: {
          rssMb: Math.round(mem.rss / 1024 / 1024),
          heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        },
        cpu: 'unknown',
        queueCounts,
        redisDetail: redisSnapshot,
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'Sistem sağlığı alınamadı' });
  }
});

router.get('/queues', async (_req: AuthRequest, res: Response) => {
  try {
    const send = await getMailSendQueueCounts().catch(() => null);
    let fetch: any = null;
    try {
      fetch = await mailFetchQueue.getJobCounts(
        'waiting',
        'active',
        'completed',
        'failed',
        'delayed',
        'paused'
      );
    } catch {
      fetch = null;
    }
    let failedJobs: any[] = [];
    try {
      const jobs = await mailSendQueue.getFailed(0, 20);
      failedJobs = jobs.map((j) => ({
        id: j.id,
        name: j.name,
        failedReason: j.failedReason ? String(j.failedReason).slice(0, 200) : null,
        timestamp: j.timestamp,
      }));
    } catch {
      failedJobs = [];
    }
    res.json({
      success: true,
      data: {
        mail: send,
        mailFetch: fetch,
        whatsapp: null,
        sms: null,
        failedJobs,
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'Kuyruk bilgisi alınamadı' });
  }
});

router.get('/logs', async (req: AuthRequest, res: Response) => {
  try {
    const type = String(req.query.type || 'application').toLowerCase();
    if (type === 'worker' || type === 'job') {
      const logs = await query(
        `SELECT id, job_type, status, message, created_at, tenant_id
         FROM job_logs ORDER BY created_at DESC LIMIT 200`
      ).catch(() => ({ rows: [] }));
      return res.json({ success: true, data: logs.rows, source: 'job_logs' });
    }
    const audit = await query(
      `SELECT id, action AS message, entity_type, tenant_id, created_at, ip_address, user_agent
       FROM platform_audit_logs ORDER BY created_at DESC LIMIT 200`
    );
    res.json({ success: true, data: audit.rows, source: 'audit' });
  } catch (error) {
    res.status(500).json({ error: 'Loglar alınamadı' });
  }
});

router.get('/devices', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
    const params: any[] = [];
    let where = `COALESCE(s.is_active,true)=true`;
    if (tenantId) {
      params.push(tenantId);
      where += ` AND u.tenant_id = $${params.length}`;
    }
    const result = await query(
      `SELECT s.id, s.user_id, s.ip_address, s.user_agent, s.device_info,
              s.created_at, s.last_activity_at, s.expires_at,
              u.email, t.name AS tenant_name
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       JOIN tenants t ON t.id = u.tenant_id
       WHERE ${where}
       ORDER BY COALESCE(s.last_activity_at, s.created_at) DESC
       LIMIT 200`,
      params
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Cihaz listesi alınamadı' });
  }
});

router.post('/devices/:id/revoke', writeLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const result = await query(
      `UPDATE user_sessions SET is_active=false, expires_at=CURRENT_TIMESTAMP
       WHERE id=$1 RETURNING id, user_id`,
      [id]
    );
    if (!result.rows[0]) return notFound(res);
    const meta = clientMeta(req);
    await writeAudit({
      actorUserId: req.user!.userId,
      action: 'SESSION_REVOKED',
      entityType: 'session',
      entityId: id,
      metadata: { userId: result.rows[0].user_id },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Oturum sonlandırılamadı' });
  }
});

router.post('/users/:id/revoke-sessions', writeLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const userId = Number(req.params.id);
    await query(
      `UPDATE user_sessions SET is_active=false, expires_at=CURRENT_TIMESTAMP
       WHERE user_id=$1 AND COALESCE(is_active,true)=true`,
      [userId]
    );
    const meta = clientMeta(req);
    await writeAudit({
      actorUserId: req.user!.userId,
      action: 'USER_SESSIONS_REVOKED',
      entityType: 'user',
      entityId: userId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Oturumlar kapatılamadı' });
  }
});

router.get('/demo-accounts', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT t.id, t.name, t.status, t.is_active, t.is_test_account, t.expires_at, t.created_at,
              (SELECT u.email FROM users u WHERE u.tenant_id=t.id
               ORDER BY CASE u.tenant_role WHEN 'OWNER' THEN 0 ELSE 1 END, u.id LIMIT 1) AS owner_email,
              CASE
                WHEN t.expires_at IS NULL THEN NULL
                ELSE GREATEST(0, CEIL(EXTRACT(EPOCH FROM (t.expires_at - CURRENT_TIMESTAMP))/86400))::int
              END AS days_left
       FROM tenants t
       WHERE t.is_test_account = true
       ORDER BY t.expires_at ASC NULLS LAST, t.created_at DESC
       LIMIT 200`
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Demo listesi alınamadı' });
  }
});

router.get('/meta', async (_req: AuthRequest, res: Response) => {
  try {
    const [accounts, connections, pendingTemplates, webhooks] = await Promise.all([
      query(
        `SELECT id, name, expires_at, status, is_active, created_at
         FROM tenants WHERE is_test_account=true AND (
           name ILIKE '%meta%' OR admin_notes ILIKE '%meta%' OR admin_notes ILIKE '%review%'
         )
         ORDER BY created_at DESC LIMIT 50`
      ),
      query(
        `SELECT cc.id, cc.tenant_id, cc.display_name, cc.status, cc.created_at, t.name AS tenant_name,
                cc.settings->>'webhook_status' AS webhook_status
         FROM channel_connections cc
         JOIN tenants t ON t.id = cc.tenant_id
         WHERE cc.channel_type='WHATSAPP'
         ORDER BY cc.created_at DESC LIMIT 100`
      ),
      query(
        `SELECT id, name, provider_approval_status, brand_id, tenant_id, updated_at
         FROM templates
         WHERE channel_type='WHATSAPP'
           AND UPPER(COALESCE(provider_approval_status,'')) IN ('PENDING','SUBMITTED','IN_REVIEW')
         ORDER BY updated_at DESC NULLS LAST LIMIT 100`
      ).catch(() => ({ rows: [] })),
      query(
        `SELECT COUNT(*) FILTER (
            WHERE COALESCE(settings->>'webhook_status','') ILIKE '%verif%'
              OR COALESCE(settings->>'webhook_status','') = 'VERIFIED'
          )::int AS verified,
          COUNT(*)::int AS total
         FROM channel_connections WHERE channel_type='WHATSAPP'`
      ),
    ]);
    res.json({
      success: true,
      data: {
        reviewAccounts: accounts.rows,
        whatsappConnections: connections.rows,
        pendingTemplates: pendingTemplates.rows,
        webhookSummary: webhooks.rows[0] || { verified: 0, total: 0 },
      },
    });
  } catch (error) {
    console.error('Meta admin error');
    res.status(500).json({ error: 'Meta yönetimi yüklenemedi' });
  }
});

router.get('/security', async (_req: AuthRequest, res: Response) => {
  try {
    const [sessions, logins, errors] = await Promise.all([
      query(
        `SELECT COUNT(*)::int AS c FROM user_sessions
         WHERE COALESCE(is_active,true)=true
           AND COALESCE(expires_at, CURRENT_TIMESTAMP + INTERVAL '1 day') > CURRENT_TIMESTAMP`
      ),
      query(
        `SELECT id, user_id, ip_address, user_agent, login_at, is_active
         FROM login_history ORDER BY login_at DESC LIMIT 50`
      ).catch(() => ({ rows: [] })),
      query(
        `SELECT COUNT(*)::int AS c FROM channel_connections WHERE status='ERROR'`
      ),
    ]);
    res.json({
      success: true,
      data: {
        activeSessions: sessions.rows[0]?.c || 0,
        recentLogins: logins.rows,
        failedLogins: [], // dedicated failed-login table yok
        suspiciousIps: [],
        channelErrors: errors.rows[0]?.c || 0,
        rateLimitNote: 'API yazma uçları rate limit ile korunuyor',
        apiKeys: [],
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'Güvenlik özeti alınamadı' });
  }
});

router.get('/brands-overview', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT b.id, b.name, b.slug, b.is_active, b.created_at, t.name AS tenant_name, t.id AS tenant_id
       FROM brands b
       JOIN tenants t ON t.id = b.tenant_id
       ORDER BY b.created_at DESC LIMIT 200`
    );
    res.json({ success: true, data: result.rows });
  } catch {
    res.status(500).json({ error: 'Marka listesi alınamadı' });
  }
});

router.get('/mail-accounts-overview', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT ma.id, ma.email, ma.is_active, ma.created_at, t.name AS tenant_name, t.id AS tenant_id
       FROM mail_accounts ma
       JOIN tenants t ON t.id = ma.tenant_id
       ORDER BY ma.created_at DESC LIMIT 200`
    );
    res.json({ success: true, data: result.rows });
  } catch {
    res.status(500).json({ error: 'Mail hesapları alınamadı' });
  }
});

router.get('/channels-overview', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT cc.id, cc.channel_type, cc.display_name, cc.status, cc.created_at,
              t.name AS tenant_name, t.id AS tenant_id
       FROM channel_connections cc
       JOIN tenants t ON t.id = cc.tenant_id
       ORDER BY cc.created_at DESC LIMIT 200`
    );
    res.json({ success: true, data: result.rows });
  } catch {
    res.status(500).json({ error: 'Kanal listesi alınamadı' });
  }
});

export default router;
