import { Router, Request, Response } from 'express';
import { query } from '../config/database';
import { hashPassword, comparePassword, generateToken, verifyToken } from '../utils/auth';
import { RegisterRequest, LoginRequest, AuthResponse } from '../types';
import { loadUserAuthContext } from '../permissions/permissionService';

const router = Router();

function buildAuthUserResponse(
  ctx: NonNullable<Awaited<ReturnType<typeof loadUserAuthContext>>>,
  entitlements?: unknown
) {
  return {
    id: ctx.id,
    email: ctx.email,
    tenant_id: ctx.tenant_id,
    name: ctx.name,
    role: ctx.role,
    tenant_role: ctx.tenant_role,
    permissions: ctx.permissions,
    permission_version: ctx.permission_version,
    entitlements: entitlements || null,
  };
}

router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password, tenantName }: RegisterRequest = req.body;

    if (!email || !password || !tenantName) {
      return res.status(400).json({
        success: false,
        error: 'Email, password, and tenant name are required',
      } as AuthResponse);
    }

    const existingUser = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'User already exists',
      } as AuthResponse);
    }

    const hashedPassword = await hashPassword(password);

    const tenantResult = await query(
      'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
      [tenantName]
    );
    const tenantId = tenantResult.rows[0].id;

    // Legacy platform role kept as admin for compatibility; tenant_role is OWNER
    const userResult = await query(
      `INSERT INTO users (email, password, tenant_id, role, tenant_role, permission_version)
       VALUES ($1, $2, $3, $4, $5, 1)
       RETURNING id, email, tenant_id, role, tenant_role`,
      [email, hashedPassword, tenantId, 'admin', 'OWNER']
    );

    const user = userResult.rows[0];

    await query(
      `INSERT INTO tags (name, color, tenant_id) VALUES 
       ('teklif', '#3B82F6', $1),
       ('müşteri', '#10B981', $1),
       ('fatura', '#F59E0B', $1)`,
      [tenantId]
    );

    // Default STARTER trial subscription
    const plan = await query(
      `SELECT id FROM plans WHERE code = 'STARTER' OR name = 'starter' ORDER BY id LIMIT 1`
    );
    if (plan.rows[0]) {
      const periodStart = new Date();
      const periodEnd = new Date(periodStart);
      periodEnd.setMonth(periodEnd.getMonth() + 1);
      await query(
        `INSERT INTO subscriptions (
           tenant_id, plan_id, status, billing_period, provider,
           current_period_start, current_period_end, trial_ends_at, cancel_at_period_end
         ) VALUES ($1,$2,'TRIAL','MONTHLY','manual',$3,$4,$5,false)`,
        [
          tenantId,
          plan.rows[0].id,
          periodStart,
          periodEnd,
          new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        ]
      );
      await query(
        `UPDATE tenants SET subscription_plan = 'starter', status = 'ACTIVE' WHERE id = $1`,
        [tenantId]
      );
    }

    const { recalculateCountUsage } = await import('../services/entitlementService');
    await recalculateCountUsage(tenantId).catch(() => null);

    const ctx = await loadUserAuthContext(user.id);
    const token = generateToken({
      userId: user.id,
      email: user.email,
      tenantId,
      role: user.role || 'admin',
      tenantRole: 'OWNER',
      permissionVersion: ctx?.permission_version || 1,
    });

    res.status(201).json({
      success: true,
      token,
      user: ctx ? buildAuthUserResponse(ctx) : {
        id: user.id,
        email: user.email,
        tenant_id: user.tenant_id,
        tenant_role: 'OWNER',
        role: user.role,
        permissions: [],
        permission_version: 1,
      },
    } as AuthResponse);
  } catch (error: any) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      error: 'Registration failed',
    } as AuthResponse);
  }
});

router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password }: LoginRequest = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required',
      } as AuthResponse);
    }

    const userResult = await query(
      `SELECT id, email, password, tenant_id, role, tenant_role, COALESCE(is_active, true) AS is_active
       FROM users WHERE email = $1`,
      [email]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials',
      } as AuthResponse);
    }

    const user = userResult.rows[0];
    if (user.is_active === false) {
      return res.status(403).json({
        success: false,
        error: 'Hesap pasif',
        code: 'ACCOUNT_DISABLED',
      });
    }

    const isPasswordValid = await comparePassword(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials',
      } as AuthResponse);
    }

    const ctx = await loadUserAuthContext(user.id);
    if (!ctx) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const token = generateToken({
      userId: user.id,
      email: user.email,
      tenantId: user.tenant_id,
      role: user.role || 'user',
      tenantRole: ctx.tenant_role || undefined,
      permissionVersion: ctx.permission_version,
    });

    await query(
      'UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    );

    const tokenHash = require('crypto').createHash('sha256').update(token).digest('hex');
    await query(
      `INSERT INTO login_history (user_id, ip_address, user_agent, device_info)
       VALUES ($1, $2, $3, $4)`,
      [user.id, req.ip, req.headers['user-agent'], req.headers['user-agent']]
    );

    await query(
      `INSERT INTO user_sessions (user_id, token_hash, ip_address, user_agent, device_info, expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '7 days')`,
      [user.id, tokenHash, req.ip, req.headers['user-agent'], req.headers['user-agent']]
    );

    res.json({
      success: true,
      token,
      user: buildAuthUserResponse(ctx),
    } as AuthResponse);
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Login failed',
    } as AuthResponse);
  }
});

router.get('/me', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.substring(7);
    const payload = verifyToken(token);

    if (!payload) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const ctx = await loadUserAuthContext(payload.userId);
    if (!ctx) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!ctx.is_active) {
      return res.status(403).json({ error: 'Hesap pasif', code: 'ACCOUNT_DISABLED' });
    }

    const tokenVersion = Number((payload as any).permissionVersion || 0);
    if (tokenVersion !== Number(ctx.permission_version)) {
      return res.status(401).json({
        error: 'Oturum yetkileri güncellendi; tekrar giriş yapın',
        code: 'PERMISSIONS_STALE',
      });
    }

    let entitlements = null;
    try {
      const {
        getTenantEntitlements,
        sanitizeEntitlementsSummary,
        recalculateCountUsage,
      } = await import('../services/entitlementService');
      await recalculateCountUsage(ctx.tenant_id).catch(() => null);
      entitlements = sanitizeEntitlementsSummary(await getTenantEntitlements(ctx.tenant_id));
    } catch {
      entitlements = null;
    }

    res.json(buildAuthUserResponse(ctx, entitlements));
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

export default router;
