import { Router, Response } from 'express'
import { pool } from '../config/database'
import { authenticate, AuthRequest } from '../middleware/auth'

const router = Router()

router.get('/threads', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { page = 1, limit = 50, status, assigned_to } = req.query
    const offset = (Number(page) - 1) * Number(limit)

    let whereClause = 'WHERE m.tenant_id = $1 AND m.is_deleted = false'
    const params: any[] = [req.user!.tenantId]
    let paramIndex = 2

    if (status) {
      whereClause += ` AND m.status = $${paramIndex++}`
      params.push(status)
    }

    if (assigned_to) {
      whereClause += ` AND m.assigned_to = $${paramIndex++}`
      params.push(assigned_to)
    }

    const result = await pool.query(`
      SELECT 
        m.thread_id,
        MAX(m.subject) as subject,
        COUNT(m.id) as message_count,
        MAX(m.date) as last_message_date,
        json_agg(DISTINCT m.from_address) as participants,
        MAX(m.id) as last_mail_id,
        MAX(m.is_read) as is_read,
        MAX(m.is_starred) as is_starred,
        MAX(m.status) as status,
        MAX(m.assigned_to) as assigned_to
      FROM mails m
      ${whereClause}
      GROUP BY m.thread_id
      ORDER BY last_message_date DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex}
    `, [...params, limit, offset])

    res.json({ success: true, data: result.rows })
  } catch (error) {
    console.error('Error fetching threads:', error)
    res.status(500).json({ success: false, error: 'Failed to fetch threads' })
  }
})

router.get('/threads/:threadId/messages', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { threadId } = req.params

    const result = await pool.query(`
      SELECT m.*, ma.email as account_email, ma.name as account_name,
        json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color)) FILTER (WHERE t.id IS NOT NULL) as tags
      FROM mails m
      LEFT JOIN mail_accounts ma ON m.account_id = ma.id
      LEFT JOIN mail_tags mt ON m.id = mt.mail_id
      LEFT JOIN tags t ON mt.tag_id = t.id
      WHERE m.thread_id = $1 AND m.tenant_id = $2 AND m.is_deleted = false
      GROUP BY m.id, ma.email, ma.name
      ORDER BY m.date ASC
    `, [threadId, req.user!.tenantId])

    res.json({ success: true, data: result.rows })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch thread messages' })
  }
})

router.put('/mails/:id/status', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params
    const { status } = req.body

    await pool.query(
      'UPDATE mails SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND tenant_id = $3',
      [status, id, req.user!.tenantId]
    )

    await pool.query(
      'INSERT INTO mail_activities (mail_id, user_id, tenant_id, action, metadata) VALUES ($1, $2, $3, $4, $5)',
      [id, req.user!.userId, req.user!.tenantId, 'status_changed', JSON.stringify({ status })]
    )

    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to update status' })
  }
})

router.put('/mails/:id/assign', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params
    const { user_id } = req.body

    await pool.query(
      'UPDATE mails SET assigned_to = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND tenant_id = $3',
      [user_id, id, req.user!.tenantId]
    )

    await pool.query(
      'INSERT INTO mail_activities (mail_id, user_id, tenant_id, action, metadata) VALUES ($1, $2, $3, $4, $5)',
      [id, req.user!.userId, req.user!.tenantId, 'assigned', JSON.stringify({ assigned_to: user_id })]
    )

    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to assign mail' })
  }
})

router.post('/mails/:id/notes', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params
    const { content } = req.body

    const result = await pool.query(
      'INSERT INTO mail_notes (mail_id, user_id, tenant_id, content) VALUES ($1, $2, $3, $4) RETURNING *',
      [id, req.user!.userId, req.user!.tenantId, content]
    )

    await pool.query(
      'INSERT INTO mail_activities (mail_id, user_id, tenant_id, action) VALUES ($1, $2, $3, $4)',
      [id, req.user!.userId, req.user!.tenantId, 'note_added']
    )

    res.json({ success: true, data: result.rows[0] })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to add note' })
  }
})

router.get('/mails/:id/notes', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params

    const result = await pool.query(`
      SELECT n.*, u.name as user_name, u.email as user_email
      FROM mail_notes n
      LEFT JOIN users u ON n.user_id = u.id
      WHERE n.mail_id = $1 AND n.tenant_id = $2
      ORDER BY n.created_at DESC
    `, [id, req.user!.tenantId])

    res.json({ success: true, data: result.rows })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch notes' })
  }
})

router.get('/mails/:id/activities', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params

    const result = await pool.query(`
      SELECT a.*, u.name as user_name, u.email as user_email
      FROM mail_activities a
      LEFT JOIN users u ON a.user_id = u.id
      WHERE a.mail_id = $1 AND a.tenant_id = $2
      ORDER BY a.created_at DESC
      LIMIT 50
    `, [id, req.user!.tenantId])

    res.json({ success: true, data: result.rows })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch activities' })
  }
})

export default router
