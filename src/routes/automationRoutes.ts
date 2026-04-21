import { Router, Response } from 'express'
import { pool } from '../config/database'
import { authenticate, AuthRequest } from '../middleware/auth'

const router = Router()

router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT * FROM automation_rules WHERE tenant_id = $1 ORDER BY created_at DESC',
      [req.user!.tenantId]
    )
    res.json({ success: true, data: result.rows })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch rules' })
  }
})

router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { name, conditions, actions, is_active = true } = req.body
    
    const result = await pool.query(
      `INSERT INTO automation_rules (name, tenant_id, conditions, actions, is_active, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name, req.user!.tenantId, JSON.stringify(conditions), JSON.stringify(actions), is_active, req.user!.userId]
    )
    
    res.json({ success: true, data: result.rows[0] })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to create rule' })
  }
})

router.put('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { name, conditions, actions, is_active } = req.body
    
    const result = await pool.query(
      `UPDATE automation_rules 
       SET name = $1, conditions = $2, actions = $3, is_active = $4, updated_at = CURRENT_TIMESTAMP
       WHERE id = $5 AND tenant_id = $6 RETURNING *`,
      [name, JSON.stringify(conditions), JSON.stringify(actions), is_active, req.params.id, req.user!.tenantId]
    )
    
    res.json({ success: true, data: result.rows[0] })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to update rule' })
  }
})

router.delete('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    await pool.query(
      'DELETE FROM automation_rules WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.user!.tenantId]
    )
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete rule' })
  }
})

export default router
