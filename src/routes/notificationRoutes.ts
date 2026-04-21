import { Router, Response } from 'express'
import { pool } from '../config/database'
import { authenticate, AuthRequest } from '../middleware/auth'

const router = Router()

router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { limit = 50, offset = 0 } = req.query
    const result = await pool.query(
      'SELECT * FROM notifications WHERE user_id = $1 AND tenant_id = $2 ORDER BY created_at DESC LIMIT $3 OFFSET $4',
      [req.user!.userId, req.user!.tenantId, limit, offset]
    )
    res.json({ success: true, notifications: result.rows })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch notifications' })
  }
})

router.get('/unread-count', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = $1 AND is_read = false',
      [req.user!.userId]
    )
    res.json({ success: true, count: parseInt(result.rows[0].count) })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch unread count' })
  }
})

router.put('/:id/read', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    await pool.query(
      'UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user!.userId]
    )
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to mark as read' })
  }
})

router.put('/mark-all-read', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    await pool.query(
      'UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false',
      [req.user!.userId]
    )
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to mark all as read' })
  }
})

export default router
