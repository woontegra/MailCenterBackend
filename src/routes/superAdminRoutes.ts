import { Router, Response } from 'express';
import { authenticate, AuthRequest, isSuperAdmin } from '../middleware/auth';
import { query } from '../config/database';
import bcrypt from 'bcrypt';

const router = Router();

router.use(authenticate);
router.use(isSuperAdmin);

const logAdminActivity = async (adminId: number, action: string, targetType: string, targetId: number, details: any, ip: string) => {
  await query(
    `INSERT INTO admin_activity_logs (admin_id, action, target_type, target_id, details, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [adminId, action, targetType, targetId, JSON.stringify(details), ip]
  );
};

router.get('/stats', async (req: AuthRequest, res: Response) => {
  try {
    const tenantsResult = await query('SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE is_active = true) as active FROM tenants');
    const usersResult = await query('SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE is_active = true) as active FROM users');
    const subscriptionsResult = await query('SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = $1) as active FROM subscriptions', ['active']);
    const mailsResult = await query('SELECT COUNT(*) as total FROM mails WHERE date > NOW() - INTERVAL $1', ['1 day']);

    res.json({
      tenants: tenantsResult.rows[0],
      users: usersResult.rows[0],
      subscriptions: subscriptionsResult.rows[0],
      mails_today: parseInt(mailsResult.rows[0].total),
    });
  } catch (error: any) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/tenants', async (req: AuthRequest, res: Response) => {
  try {
    const { page = 1, limit = 20, search = '' } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const result = await query(
      `SELECT t.*, 
              COUNT(DISTINCT u.id) as user_count,
              COUNT(DISTINCT ma.id) as account_count,
              s.status as subscription_status,
              p.display_name as plan_name,
              p.name as plan_code
       FROM tenants t
       LEFT JOIN users u ON t.id = u.tenant_id
       LEFT JOIN mail_accounts ma ON t.id = ma.tenant_id
       LEFT JOIN subscriptions s ON t.id = s.tenant_id AND s.status = 'active'
       LEFT JOIN plans p ON s.plan_id = p.id
       WHERE t.name ILIKE $1
       GROUP BY t.id, s.status, p.display_name, p.name
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

router.post('/tenants', async (req: AuthRequest, res: Response) => {
  try {
    const { name, email, password, planId } = req.body;

    const tenantResult = await query(
      'INSERT INTO tenants (name) VALUES ($1) RETURNING *',
      [name]
    );
    const tenant = tenantResult.rows[0];

    const hashedPassword = await bcrypt.hash(password, 10);
    const userResult = await query(
      'INSERT INTO users (email, password, tenant_id, role) VALUES ($1, $2, $3, $4) RETURNING *',
      [email, hashedPassword, tenant.id, 'admin']
    );

    if (planId) {
      await query(
        'INSERT INTO subscriptions (tenant_id, plan_id, status) VALUES ($1, $2, $3)',
        [tenant.id, planId, 'active']
      );
    }

    await logAdminActivity(req.user!.userId, 'tenant_create', 'tenant', tenant.id, { name, email }, req.ip || '');

    res.status(201).json({ tenant, user: userResult.rows[0] });
  } catch (error: any) {
    console.error('Create tenant error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/tenants/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const tenantResult = await query('SELECT * FROM tenants WHERE id = $1', [id]);
    if (tenantResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    await query('DELETE FROM tenants WHERE id = $1', [id]);

    await logAdminActivity(req.user!.userId, 'tenant_delete', 'tenant', parseInt(id), tenantResult.rows[0], req.ip || '');

    res.json({ success: true });
  } catch (error: any) {
    console.error('Delete tenant error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/users', async (req: AuthRequest, res: Response) => {
  try {
    const { page = 1, limit = 20, search = '', role = '' } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let whereClause = '(u.email ILIKE $1 OR u.name ILIKE $1)';
    const params: any[] = [`%${search}%`];

    if (role) {
      whereClause += ' AND u.role = $' + (params.length + 1);
      params.push(role);
    }

    params.push(limit, offset);

    const result = await query(
      `SELECT u.*, t.name as tenant_name
       FROM users u
       JOIN tenants t ON u.tenant_id = t.id
       WHERE ${whereClause}
       ORDER BY u.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const countResult = await query(
      `SELECT COUNT(*) FROM users u WHERE ${whereClause}`,
      params.slice(0, -2)
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

router.patch('/users/:id/role', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!['user', 'admin', 'super_admin'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const userResult = await query('SELECT * FROM users WHERE id = $1', [id]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);

    await logAdminActivity(req.user!.userId, 'user_role_change', 'user', parseInt(id), { old_role: userResult.rows[0].role, new_role: role }, req.ip || '');

    res.json({ success: true });
  } catch (error: any) {
    console.error('Update user role error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/subscriptions', async (req: AuthRequest, res: Response) => {
  try {
    const { page = 1, limit = 20, status = '' } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let whereClause = '1=1';
    const params: any[] = [];

    if (status) {
      whereClause += ' AND s.status = $' + (params.length + 1);
      params.push(status);
    }

    params.push(limit, offset);

    const result = await query(
      `SELECT s.*, t.name as tenant_name, p.display_name as plan_name
       FROM subscriptions s
       JOIN tenants t ON s.tenant_id = t.id
       JOIN plans p ON s.plan_id = p.id
       WHERE ${whereClause}
       ORDER BY s.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const countResult = await query(
      `SELECT COUNT(*) FROM subscriptions s WHERE ${whereClause}`,
      params.slice(0, -2)
    );

    res.json({
      subscriptions: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: Number(page),
      limit: Number(limit),
    });
  } catch (error: any) {
    console.error('Get subscriptions error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.patch('/subscriptions/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { planId, status } = req.body;

    const subResult = await query('SELECT * FROM subscriptions WHERE id = $1', [id]);
    if (subResult.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (planId) {
      updates.push(`plan_id = $${paramIndex}`);
      values.push(planId);
      paramIndex++;
    }

    if (status) {
      updates.push(`status = $${paramIndex}`);
      values.push(status);
      paramIndex++;
    }

    if (updates.length > 0) {
      values.push(id);
      await query(
        `UPDATE subscriptions SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramIndex}`,
        values
      );

      await logAdminActivity(req.user!.userId, 'subscription_update', 'subscription', parseInt(id), { planId, status }, req.ip || '');
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error('Update subscription error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/activity-logs', async (req: AuthRequest, res: Response) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const result = await query(
      `SELECT al.*, u.email as admin_email, u.name as admin_name
       FROM admin_activity_logs al
       JOIN users u ON al.admin_id = u.id
       ORDER BY al.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const countResult = await query('SELECT COUNT(*) FROM admin_activity_logs');

    res.json({
      logs: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: Number(page),
      limit: Number(limit),
    });
  } catch (error: any) {
    console.error('Get activity logs error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
