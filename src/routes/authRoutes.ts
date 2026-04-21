import { Router, Request, Response } from 'express';
import { query } from '../config/database';
import { hashPassword, comparePassword, generateToken } from '../utils/auth';
import { RegisterRequest, LoginRequest, AuthResponse } from '../types';

const router = Router();

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

    const userResult = await query(
      'INSERT INTO users (email, password, tenant_id) VALUES ($1, $2, $3) RETURNING id, email, tenant_id',
      [email, hashedPassword, tenantId]
    );

    const user = userResult.rows[0];

    await query(
      `INSERT INTO tags (name, color, tenant_id) VALUES 
       ('teklif', '#3B82F6', $1),
       ('müşteri', '#10B981', $1),
       ('fatura', '#F59E0B', $1)`,
      [tenantId]
    );

    const token = generateToken({
      userId: user.id,
      email: user.email,
      tenantId: user.tenant_id,
    });

    res.status(201).json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        tenant_id: user.tenant_id,
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
      'SELECT id, email, password, tenant_id FROM users WHERE email = $1',
      [email]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials',
      } as AuthResponse);
    }

    const user = userResult.rows[0];
    const isPasswordValid = await comparePassword(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials',
      } as AuthResponse);
    }

    const token = generateToken({
      userId: user.id,
      email: user.email,
      tenantId: user.tenant_id,
    });

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        tenant_id: user.tenant_id,
      },
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
    const { verifyToken } = await import('../utils/auth');
    const payload = verifyToken(token);

    if (!payload) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const userResult = await query(
      'SELECT id, email, tenant_id FROM users WHERE id = $1',
      [payload.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(userResult.rows[0]);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

export default router;
