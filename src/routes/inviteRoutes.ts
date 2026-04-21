import { Router, Response } from 'express'
import { pool } from '../config/database'
import { authenticate, AuthRequest } from '../middleware/auth'
import crypto from 'crypto'

const router = Router()

router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { email, role = 'member' } = req.body
    
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1 AND tenant_id = $2',
      [email, req.user!.tenantId]
    )

    if (existingUser.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'User already exists' })
    }

    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days

    const result = await pool.query(
      `INSERT INTO invites (email, tenant_id, invited_by, role, token, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [email, req.user!.tenantId, req.user!.userId, role, token, expiresAt]
    )

    res.json({ success: true, data: result.rows[0], inviteLink: `${process.env.FRONTEND_URL}/invite/${token}` })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to create invite' })
  }
})

router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT * FROM invites WHERE tenant_id = $1 ORDER BY created_at DESC',
      [req.user!.tenantId]
    )
    res.json({ success: true, data: result.rows })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch invites' })
  }
})

router.get('/verify/:token', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM invites WHERE token = $1 AND expires_at > NOW() AND accepted_at IS NULL',
      [req.params.token]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Invalid or expired invite' })
    }

    res.json({ success: true, data: result.rows[0] })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to verify invite' })
  }
})

router.post('/accept/:token', async (req, res) => {
  try {
    const { password, name } = req.body
    
    const inviteResult = await pool.query(
      'SELECT * FROM invites WHERE token = $1 AND expires_at > NOW() AND accepted_at IS NULL',
      [req.params.token]
    )

    if (inviteResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Invalid or expired invite' })
    }

    const invite = inviteResult.rows[0]
    
    const bcrypt = require('bcrypt')
    const hashedPassword = await bcrypt.hash(password, 10)

    await pool.query('BEGIN')

    const userResult = await pool.query(
      `INSERT INTO users (email, password, name, tenant_id, role)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [invite.email, hashedPassword, name, invite.tenant_id, invite.role]
    )

    await pool.query(
      'UPDATE invites SET accepted_at = CURRENT_TIMESTAMP WHERE id = $1',
      [invite.id]
    )

    await pool.query('COMMIT')

    res.json({ success: true, user: userResult.rows[0] })
  } catch (error) {
    await pool.query('ROLLBACK')
    res.status(500).json({ success: false, error: 'Failed to accept invite' })
  }
})

export default router
