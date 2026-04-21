import { Router, Response } from 'express'
import { pool } from '../config/database'
import { authenticate, AuthRequest } from '../middleware/auth'

const router = Router()

router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT * FROM templates 
       WHERE tenant_id = $1 AND (created_by = $2 OR is_shared = true)
       ORDER BY created_at DESC`,
      [req.user!.tenantId, req.user!.userId]
    )
    res.json({ success: true, data: result.rows })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch templates' })
  }
})

router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { name, content, is_shared = false } = req.body
    
    const result = await pool.query(
      `INSERT INTO templates (name, content, tenant_id, created_by, is_shared)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, content, req.user!.tenantId, req.user!.userId, is_shared]
    )
    
    res.json({ success: true, data: result.rows[0] })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to create template' })
  }
})

router.put('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { name, content, is_shared } = req.body
    
    const result = await pool.query(
      `UPDATE templates 
       SET name = $1, content = $2, is_shared = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 AND created_by = $5 AND tenant_id = $6 RETURNING *`,
      [name, content, is_shared, req.params.id, req.user!.userId, req.user!.tenantId]
    )
    
    res.json({ success: true, data: result.rows[0] })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to update template' })
  }
})

router.delete('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    await pool.query(
      'DELETE FROM templates WHERE id = $1 AND created_by = $2 AND tenant_id = $3',
      [req.params.id, req.user!.userId, req.user!.tenantId]
    )
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete template' })
  }
})

export default router
