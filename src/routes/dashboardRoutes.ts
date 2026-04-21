import { Router, Request, Response } from 'express';
import { query } from '../config/database';

const router = Router();

router.get('/dashboard/stats', async (req: Request, res: Response) => {
  try {
    const unreadCount = await query(
      'SELECT COUNT(*) as count FROM mails WHERE is_read = false AND is_deleted = false'
    );

    const starredCount = await query(
      'SELECT COUNT(*) as count FROM mails WHERE is_starred = true AND is_deleted = false'
    );

    const accountStats = await query(`
      SELECT 
        ma.id,
        ma.name,
        ma.email,
        COUNT(m.id) as total_mails,
        COUNT(m.id) FILTER (WHERE m.is_read = false) as unread_mails
      FROM mail_accounts ma
      LEFT JOIN mails m ON ma.id = m.account_id AND m.is_deleted = false
      WHERE ma.is_active = true
      GROUP BY ma.id, ma.name, ma.email
      ORDER BY ma.name
    `);

    res.json({
      unread: parseInt(unreadCount.rows[0].count),
      starred: parseInt(starredCount.rows[0].count),
      accounts: accountStats.rows,
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

export default router;
