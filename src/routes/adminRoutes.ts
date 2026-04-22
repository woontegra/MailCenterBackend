import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { query } from '../config/database';

const router = Router();

const requireSuperAdmin = (req: AuthRequest, res: Response, next: Function) => {
  if (req.user!.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
};

router.use(authenticate);
router.use(requireSuperAdmin);

router.get('/tenants', async (req: AuthRequest, res: Response) => {
  try {
    const { page = 1, limit = 20, search = '' } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const result = await query(
      `SELECT t.*, 
              COUNT(DISTINCT u.id) as user_count,
              COUNT(DISTINCT ma.id) as account_count,
              s.status as subscription_status,
              p.display_name as plan_name
       FROM tenants t
       LEFT JOIN users u ON t.id = u.tenant_id
       LEFT JOIN mail_accounts ma ON t.id = ma.tenant_id
       LEFT JOIN subscriptions s ON t.id = s.tenant_id AND s.status = 'active'
       LEFT JOIN plans p ON s.plan_id = p.id
       WHERE t.name ILIKE $1
       GROUP BY t.id, s.status, p.display_name
       ORDER BY t.created_at DESC
       LIMIT $2 OFFSET $3`,
      [`%${search}%`, limit, offset]
    );

    const countResult = await query(
      'SELECT COUNT(*) FROM tenants WHERE name ILIKE $1',
      [`%${search}%`]
    );

    res.json({
      tenants: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: Number(page),
      limit: Number(limit),
    });
  } catch (error: any) {
    console.error('Get tenants error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/tenants/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const tenantResult = await query('SELECT * FROM tenants WHERE id = $1', [id]);
    if (tenantResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const usersResult = await query(
      'SELECT id, email, name, role, is_active, last_login FROM users WHERE tenant_id = $1',
      [id]
    );

    const accountsResult = await query(
      'SELECT id, name, email, is_active, last_sync_at FROM mail_accounts WHERE tenant_id = $1',
      [id]
    );

    const subscriptionResult = await query(
      `SELECT s.*, p.display_name as plan_name
       FROM subscriptions s
       JOIN plans p ON s.plan_id = p.id
       WHERE s.tenant_id = $1
       ORDER BY s.created_at DESC LIMIT 1`,
      [id]
    );

    res.json({
      tenant: tenantResult.rows[0],
      users: usersResult.rows,
      accounts: accountsResult.rows,
      subscription: subscriptionResult.rows[0] || null,
    });
  } catch (error: any) {
    console.error('Get tenant details error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/tenants/:id/status', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    await query('UPDATE tenants SET is_active = $1 WHERE id = $2', [is_active, id]);

    res.json({ success: true });
  } catch (error: any) {
    console.error('Update tenant status error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/users', async (req: AuthRequest, res: Response) => {
  try {
    const { page = 1, limit = 20, search = '' } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const result = await query(
      `SELECT u.*, t.name as tenant_name
       FROM users u
       JOIN tenants t ON u.tenant_id = t.id
       WHERE u.email ILIKE $1 OR u.name ILIKE $1
       ORDER BY u.created_at DESC
       LIMIT $2 OFFSET $3`,
      [`%${search}%`, limit, offset]
    );

    const countResult = await query(
      'SELECT COUNT(*) FROM users WHERE email ILIKE $1 OR name ILIKE $1',
      [`%${search}%`]
    );

    res.json({
      users: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: Number(page),
      limit: Number(limit),
    });
  } catch (error: any) {
    console.error('Get users error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/logs/errors', async (req: AuthRequest, res: Response) => {
  try {
    const { page = 1, limit = 50, severity = '', resolved = '' } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let whereClause = '1=1';
    const params: any[] = [];
    let paramIndex = 1;

    if (severity) {
      whereClause += ` AND severity = $${paramIndex}`;
      params.push(severity);
      paramIndex++;
    }

    if (resolved !== '') {
      whereClause += ` AND resolved = $${paramIndex}`;
      params.push(resolved === 'true');
      paramIndex++;
    }

    params.push(limit, offset);

    const result = await query(
      `SELECT el.*, t.name as tenant_name, u.email as user_email
       FROM error_logs el
       LEFT JOIN tenants t ON el.tenant_id = t.id
       LEFT JOIN users u ON el.user_id = u.id
       WHERE ${whereClause}
       ORDER BY el.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      params
    );

    const countResult = await query(
      `SELECT COUNT(*) FROM error_logs WHERE ${whereClause}`,
      params.slice(0, -2)
    );

    res.json({
      logs: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: Number(page),
      limit: Number(limit),
    });
  } catch (error: any) {
    console.error('Get error logs error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/logs/errors/:id/resolve', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    await query('UPDATE error_logs SET resolved = true WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Resolve error log error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/stats', async (req: AuthRequest, res: Response) => {
  try {
    const tenantsResult = await query('SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE is_active = true) as active FROM tenants');
    const usersResult = await query('SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE is_active = true) as active FROM users');
    const subscriptionsResult = await query('SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = $1) as active FROM subscriptions', ['active']);
    const mailsResult = await query('SELECT COUNT(*) as total FROM mails WHERE date > NOW() - INTERVAL $1', ['30 days']);

    res.json({
      tenants: tenantsResult.rows[0],
      users: usersResult.rows[0],
      subscriptions: subscriptionsResult.rows[0],
      mails_last_30_days: parseInt(mailsResult.rows[0].total),
    });
  } catch (error: any) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
