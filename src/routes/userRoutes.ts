import { Router, Response } from 'express'
import { pool } from '../config/database'
import { authenticate, AuthRequest } from '../middleware/auth'
import bcrypt from 'bcrypt'

const router = Router()

router.get('/profile', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT id, email, name, avatar_url, role, preferences, last_login FROM users WHERE id = $1',
      [req.user!.userId]
    )
    res.json({ success: true, user: result.rows[0] })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch profile' })
  }
})

router.put('/profile', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { name, avatar_url, preferences } = req.body
    const result = await pool.query(
      'UPDATE users SET name = $1, avatar_url = $2, preferences = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4 RETURNING id, email, name, avatar_url, role, preferences',
      [name, avatar_url, preferences, req.user!.userId]
    )
    res.json({ success: true, user: result.rows[0] })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to update profile' })
  }
})

router.put('/password', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body
    const userResult = await pool.query('SELECT password FROM users WHERE id = $1', [req.user!.userId])
    const isValid = await bcrypt.compare(currentPassword, userResult.rows[0].password)
    
    if (!isValid) {
      return res.status(400).json({ success: false, error: 'Current password is incorrect' })
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10)
    await pool.query('UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [hashedPassword, req.user!.userId])
    
    res.json({ success: true, message: 'Password updated successfully' })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to update password' })
  }
})

router.get('/team', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT id, email, name, avatar_url, role, is_active, last_login FROM users WHERE tenant_id = $1 ORDER BY created_at DESC',
      [req.user!.tenantId]
    )
    res.json({ success: true, users: result.rows })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch team' })
  }
})

export default router
