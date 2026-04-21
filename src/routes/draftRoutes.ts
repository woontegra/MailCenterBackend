import { Router, Response } from 'express'
import { pool } from '../config/database'
import { authenticate, AuthRequest } from '../middleware/auth'

const router = Router()

router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT * FROM drafts WHERE user_id = $1 AND tenant_id = $2 ORDER BY updated_at DESC',
      [req.user!.userId, req.user!.tenantId]
    )
    res.json({ success: true, data: result.rows })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch drafts' })
  }
})

router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { account_id, to_address, cc_address, bcc_address, subject, body, attachments } = req.body
    
    const result = await pool.query(
      `INSERT INTO drafts (user_id, tenant_id, account_id, to_address, cc_address, bcc_address, subject, body, attachments)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.user!.userId, req.user!.tenantId, account_id, to_address, cc_address, bcc_address, subject, body, JSON.stringify(attachments || [])]
    )
    
    res.json({ success: true, data: result.rows[0] })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to create draft' })
  }
})

router.put('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { account_id, to_address, cc_address, bcc_address, subject, body, attachments } = req.body
    
    const result = await pool.query(
      `UPDATE drafts 
       SET account_id = $1, to_address = $2, cc_address = $3, bcc_address = $4, subject = $5, body = $6, attachments = $7, updated_at = CURRENT_TIMESTAMP
       WHERE id = $8 AND user_id = $9 AND tenant_id = $10 RETURNING *`,
      [account_id, to_address, cc_address, bcc_address, subject, body, JSON.stringify(attachments || []), req.params.id, req.user!.userId, req.user!.tenantId]
    )
    
    res.json({ success: true, data: result.rows[0] })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to update draft' })
  }
})

router.delete('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    await pool.query(
      'DELETE FROM drafts WHERE id = $1 AND user_id = $2 AND tenant_id = $3',
      [req.params.id, req.user!.userId, req.user!.tenantId]
    )
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete draft' })
  }
})

export default router
