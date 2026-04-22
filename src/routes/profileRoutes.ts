import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { query } from '../config/database';
import { hashPassword, comparePassword } from '../utils/auth';
import { S3Service } from '../services/s3Service';
import crypto from 'crypto';

const router = Router();
const s3Service = new S3Service();

router.use(authenticate);

router.get('/profile', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT u.id, u.email, u.name, u.avatar_url, u.role, u.last_login_at, 
              u.notification_enabled, u.sound_enabled, u.theme, t.name as tenant_name
       FROM users u
       JOIN tenants t ON u.tenant_id = t.id
       WHERE u.id = $1`,
      [req.user!.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (error: any) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/profile', async (req: AuthRequest, res: Response) => {
  try {
    const { name, notification_enabled, sound_enabled, theme } = req.body;

    await query(
      `UPDATE users 
       SET name = $1, notification_enabled = $2, sound_enabled = $3, theme = $4, updated_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
      [name, notification_enabled, sound_enabled, theme, req.user!.userId]
    );

    res.json({ success: true });
  } catch (error: any) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/avatar', async (req: AuthRequest, res: Response) => {
  try {
    const { avatar } = req.body;

    if (!avatar) {
      return res.status(400).json({ error: 'Avatar data required' });
    }

    const base64Data = avatar.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const fileName = `avatars/${req.user!.userId}-${Date.now()}.jpg`;

    const avatarUrl = await s3Service.uploadFile(buffer, fileName, 'image/jpeg');

    await query(
      'UPDATE users SET avatar_url = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [avatarUrl, req.user!.userId]
    );

    res.json({ success: true, avatar_url: avatarUrl });
  } catch (error: any) {
    console.error('Upload avatar error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/password', async (req: AuthRequest, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    const userResult = await query(
      'SELECT password FROM users WHERE id = $1',
      [req.user!.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const isValid = await comparePassword(currentPassword, userResult.rows[0].password);

    if (!isValid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hashedPassword = await hashPassword(newPassword);

    await query(
      'UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [hashedPassword, req.user!.userId]
    );

    res.json({ success: true });
  } catch (error: any) {
    console.error('Change password error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/sessions', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT id, ip_address, user_agent, device_info, created_at, last_activity_at, is_active
       FROM user_sessions
       WHERE user_id = $1 AND is_active = true
       ORDER BY last_activity_at DESC`,
      [req.user!.userId]
    );

    res.json(result.rows);
  } catch (error: any) {
    console.error('Get sessions error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/sessions/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    await query(
      'UPDATE user_sessions SET is_active = false, logout_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2',
      [id, req.user!.userId]
    );

    res.json({ success: true });
  } catch (error: any) {
    console.error('Delete session error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/login-history', async (req: AuthRequest, res: Response) => {
  try {
    const { limit = 20 } = req.query;

    const result = await query(
      `SELECT ip_address, user_agent, device_info, login_at, logout_at
       FROM login_history
       WHERE user_id = $1
       ORDER BY login_at DESC
       LIMIT $2`,
      [req.user!.userId, limit]
    );

    res.json(result.rows);
  } catch (error: any) {
    console.error('Get login history error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
