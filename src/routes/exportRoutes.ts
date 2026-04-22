import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { query } from '../config/database';
import { Parser } from 'json2csv';

const router = Router();

router.use(authenticate);

router.get('/mails/csv', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { start_date, end_date } = req.query;

    let sql = 'SELECT * FROM mails WHERE tenant_id = $1';
    const params: any[] = [tenantId];

    if (start_date) {
      params.push(start_date);
      sql += ` AND date >= $${params.length}`;
    }

    if (end_date) {
      params.push(end_date);
      sql += ` AND date <= $${params.length}`;
    }

    sql += ' ORDER BY date DESC LIMIT 10000';

    const result = await query(sql, params);

    const fields = ['id', 'subject', 'from_address', 'to_address', 'date', 'is_read', 'is_starred'];
    const parser = new Parser({ fields });
    const csv = parser.parse(result.rows);

    res.header('Content-Type', 'text/csv');
    res.header('Content-Disposition', `attachment; filename="mails-${Date.now()}.csv"`);
    res.send(csv);
  } catch (error: any) {
    console.error('Export CSV error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/mails/json', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { start_date, end_date } = req.query;

    let sql = 'SELECT * FROM mails WHERE tenant_id = $1';
    const params: any[] = [tenantId];

    if (start_date) {
      params.push(start_date);
      sql += ` AND date >= $${params.length}`;
    }

    if (end_date) {
      params.push(end_date);
      sql += ` AND date <= $${params.length}`;
    }

    sql += ' ORDER BY date DESC LIMIT 10000';

    const result = await query(sql, params);

    res.header('Content-Type', 'application/json');
    res.header('Content-Disposition', `attachment; filename="mails-${Date.now()}.json"`);
    res.json(result.rows);
  } catch (error: any) {
    console.error('Export JSON error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
