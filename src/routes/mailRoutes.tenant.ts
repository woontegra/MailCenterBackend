import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();

router.use(authenticate);

router.get('/mails', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { 
      is_deleted = false, 
      is_read, 
      is_starred, 
      is_sent,
      page = 1,
      limit = 50,
      search,
      from,
      subject,
      date_from,
      date_to,
      account_id,
      tag_id
    } = req.query
    
    const offset = (Number(page) - 1) * Number(limit);

    let sqlQuery = `
      SELECT m.*, ma.email as account_email, ma.name as account_name,
        json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color)) FILTER (WHERE t.id IS NOT NULL) as tags
      FROM mails m
      LEFT JOIN mail_accounts ma ON m.account_id = ma.id
      LEFT JOIN mail_tags mt ON m.id = mt.mail_id
      LEFT JOIN tags t ON mt.tag_id = t.id
      WHERE m.tenant_id = $1 AND m.is_deleted = $2
    `
    const params: any[] = [req.user!.tenantId, is_deleted]
    let paramIndex = 3

    if (account_id) {
      sqlQuery += ` AND m.account_id = $${paramIndex}`;
      params.push(account_id);
      paramIndex++;
    }

    if (is_read !== undefined) {
      sqlQuery += ` AND m.is_read = $${paramIndex++}`
      params.push(is_read === 'true')
    }
    if (is_starred !== undefined) {
      sqlQuery += ` AND m.is_starred = $${paramIndex++}`
      params.push(is_starred === 'true')
    }
    if (is_sent !== undefined) {
      sqlQuery += ` AND m.is_sent = $${paramIndex++}`
      params.push(is_sent === 'true')
    }
    if (search) {
      sqlQuery += ` AND (m.subject ILIKE $${paramIndex} OR m.from_address ILIKE $${paramIndex} OR m.body_preview ILIKE $${paramIndex})`
      params.push(`%${search}%`)
      paramIndex++
    }
    if (from) {
      sqlQuery += ` AND m.from_address ILIKE $${paramIndex++}`
      params.push(`%${from}%`)
    }
    if (subject) {
      sqlQuery += ` AND m.subject ILIKE $${paramIndex++}`
      params.push(`%${subject}%`)
    }
    if (date_from) {
      sqlQuery += ` AND m.date >= $${paramIndex++}`
      params.push(date_from)
    }
    if (date_to) {
      sqlQuery += ` AND m.date <= $${paramIndex++}`
      params.push(date_to)
    }
    if (tag_id) {
      sqlQuery += ` AND EXISTS (SELECT 1 FROM mail_tags WHERE mail_id = m.id AND tag_id = $${paramIndex++})`
      params.push(tag_id)
    }

    sqlQuery += ` GROUP BY m.id, ma.email, ma.name ORDER BY m.date DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`
    params.push(limit, offset)
    
    const countQuery = `
      SELECT COUNT(DISTINCT m.id) as total
      FROM mails m
      WHERE m.tenant_id = $1 AND m.is_deleted = $2
      ${is_read !== undefined ? ` AND m.is_read = $3` : ''}
      ${is_starred !== undefined ? ` AND m.is_starred = $${params.findIndex(p => p === (is_starred === 'true')) + 1}` : ''}
    `

    const [result, countResult] = await Promise.all([
      query(sqlQuery, params),
      query(countQuery, params.slice(0, 3))
    ])
    
    const total = parseInt(countResult.rows[0]?.total || 0)
    const totalPages = Math.ceil(total / Number(limit))
    
    res.json({ 
      success: true, 
      data: result.rows,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages
      }
    });
  } catch (error) {
    console.error('Error fetching mails:', error);
    res.status(500).json({ error: 'Failed to fetch mails' });
  }
});

router.patch('/mails/:id/read', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { is_read } = req.body;
    const tenantId = req.user!.tenantId;

    const result = await query(
      `UPDATE mails SET is_read = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2 AND tenant_id = $3 RETURNING *`,
      [is_read, id, tenantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Mail not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating mail:', error);
    res.status(500).json({ error: 'Failed to update mail' });
  }
});

router.patch('/mails/:id/star', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { is_starred } = req.body;
    const tenantId = req.user!.tenantId;

    const result = await query(
      `UPDATE mails SET is_starred = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2 AND tenant_id = $3 RETURNING *`,
      [is_starred, id, tenantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Mail not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating mail:', error);
    res.status(500).json({ error: 'Failed to update mail' });
  }
});

router.delete('/mails/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user!.tenantId;

    const result = await query(
      `UPDATE mails SET is_deleted = true, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Mail not found' });
    }

    res.json({ message: 'Mail deleted successfully' });
  } catch (error) {
    console.error('Error deleting mail:', error);
    res.status(500).json({ error: 'Failed to delete mail' });
  }
});

router.post('/mails/:id/tags', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { tag_id } = req.body;
    const tenantId = req.user!.tenantId;

    await query(
      `INSERT INTO mail_tags (mail_id, tag_id, tenant_id) 
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [id, tag_id, tenantId]
    );

    res.json({ message: 'Tag added successfully' });
  } catch (error) {
    console.error('Error adding tag:', error);
    res.status(500).json({ error: 'Failed to add tag' });
  }
});

router.delete('/mails/:id/tags/:tag_id', async (req: AuthRequest, res: Response) => {
  try {
    const { id, tag_id } = req.params;
    const tenantId = req.user!.tenantId;

    await query(
      `DELETE FROM mail_tags WHERE mail_id = $1 AND tag_id = $2 AND tenant_id = $3`,
      [id, tag_id, tenantId]
    );

    res.json({ message: 'Tag removed successfully' });
  } catch (error) {
    console.error('Error removing tag:', error);
    res.status(500).json({ error: 'Failed to remove tag' });
  }
});

export default router;
