import { Router, Response } from 'express'
import { pool } from '../config/database'
import { authenticate, AuthRequest } from '../middleware/auth'

const router = Router()

router.get('/overview', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { days = 30 } = req.query
    
    const [dailyStats, topAccounts, tagDistribution, statusDistribution] = await Promise.all([
      pool.query(`
        SELECT DATE(date) as day, COUNT(*) as count
        FROM mails
        WHERE tenant_id = $1 AND date >= NOW() - INTERVAL '${days} days'
        GROUP BY DATE(date)
        ORDER BY day DESC
      `, [req.user!.tenantId]),
      
      pool.query(`
        SELECT ma.name, ma.email, COUNT(m.id) as mail_count
        FROM mails m
        JOIN mail_accounts ma ON m.account_id = ma.id
        WHERE m.tenant_id = $1
        GROUP BY ma.id, ma.name, ma.email
        ORDER BY mail_count DESC
        LIMIT 5
      `, [req.user!.tenantId]),
      
      pool.query(`
        SELECT t.name, t.color, COUNT(mt.mail_id) as count
        FROM tags t
        LEFT JOIN mail_tags mt ON t.id = mt.tag_id
        WHERE t.tenant_id = $1
        GROUP BY t.id, t.name, t.color
        ORDER BY count DESC
      `, [req.user!.tenantId]),
      
      pool.query(`
        SELECT status, COUNT(*) as count
        FROM mails
        WHERE tenant_id = $1 AND is_deleted = false
        GROUP BY status
      `, [req.user!.tenantId])
    ])

    res.json({
      success: true,
      data: {
        dailyStats: dailyStats.rows,
        topAccounts: topAccounts.rows,
        tagDistribution: tagDistribution.rows,
        statusDistribution: statusDistribution.rows
      }
    })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch analytics' })
  }
})

router.get('/response-time', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT 
        AVG(EXTRACT(EPOCH FROM (reply.date - original.date))/3600) as avg_hours,
        COUNT(*) as total_replies
      FROM mails original
      JOIN mails reply ON reply.in_reply_to = original.message_id
      WHERE original.tenant_id = $1 AND original.date >= NOW() - INTERVAL '30 days'
    `, [req.user!.tenantId])

    res.json({ success: true, data: result.rows[0] })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch response time' })
  }
})

export default router
