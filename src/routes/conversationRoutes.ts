import { Router, Response } from 'express'
import { pool } from '../config/database'
import { authenticate, AuthRequest } from '../middleware/auth'

const router = Router()

router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT c.*, 
        COUNT(m.id) as message_count,
        MAX(m.date) as last_message_at
      FROM conversations c
      LEFT JOIN mails m ON m.conversation_id = c.id
      WHERE c.tenant_id = $1
      GROUP BY c.id
      ORDER BY last_message_at DESC NULLS LAST
    `, [req.user!.tenantId])

    res.json({ success: true, data: result.rows })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch conversations' })
  }
})

router.get('/:id/messages', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT m.*, ma.email as account_email, ma.name as account_name
      FROM mails m
      LEFT JOIN mail_accounts ma ON m.account_id = ma.id
      WHERE m.conversation_id = $1 AND m.tenant_id = $2
      ORDER BY m.date ASC
    `, [req.params.id, req.user!.tenantId])

    res.json({ success: true, data: result.rows })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch conversation messages' })
  }
})

export default router
