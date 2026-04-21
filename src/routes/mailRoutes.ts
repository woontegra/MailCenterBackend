import { Router, Request, Response } from 'express';
import { query } from '../config/database';

const router = Router();

router.get('/mails', async (req: Request, res: Response) => {
  try {
    const { account_id, is_read, is_starred, is_deleted, tag_id, search } = req.query;

    let queryText = `
      SELECT DISTINCT m.*, 
        ma.email as account_email,
        ma.name as account_name,
        COALESCE(
          json_agg(
            json_build_object('id', t.id, 'name', t.name, 'color', t.color)
          ) FILTER (WHERE t.id IS NOT NULL), '[]'
        ) as tags
      FROM mails m
      LEFT JOIN mail_accounts ma ON m.account_id = ma.id
      LEFT JOIN mail_tags mt ON m.id = mt.mail_id
      LEFT JOIN tags t ON mt.tag_id = t.id
      WHERE 1=1
    `;

    const params: any[] = [];
    let paramIndex = 1;

    if (account_id) {
      queryText += ` AND m.account_id = $${paramIndex}`;
      params.push(account_id);
      paramIndex++;
    }

    if (is_read !== undefined) {
      queryText += ` AND m.is_read = $${paramIndex}`;
      params.push(is_read === 'true');
      paramIndex++;
    }

    if (is_starred !== undefined) {
      queryText += ` AND m.is_starred = $${paramIndex}`;
      params.push(is_starred === 'true');
      paramIndex++;
    }

    if (is_deleted !== undefined) {
      queryText += ` AND m.is_deleted = $${paramIndex}`;
      params.push(is_deleted === 'true');
      paramIndex++;
    } else {
      queryText += ` AND m.is_deleted = false`;
    }

    if (tag_id) {
      queryText += ` AND EXISTS (
        SELECT 1 FROM mail_tags WHERE mail_id = m.id AND tag_id = $${paramIndex}
      )`;
      params.push(tag_id);
      paramIndex++;
    }

    if (search) {
      queryText += ` AND (m.subject ILIKE $${paramIndex} OR m.from_address ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    queryText += ` GROUP BY m.id, ma.email, ma.name ORDER BY m.date DESC LIMIT 100`;

    const result = await query(queryText, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching mails:', error);
    res.status(500).json({ error: 'Failed to fetch mails' });
  }
});

router.patch('/mails/:id/read', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { is_read } = req.body;

    const result = await query(
      `UPDATE mails SET is_read = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      [is_read, id]
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

router.patch('/mails/:id/star', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { is_starred } = req.body;

    const result = await query(
      `UPDATE mails SET is_starred = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      [is_starred, id]
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

router.delete('/mails/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const result = await query(
      `UPDATE mails SET is_deleted = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
      [id]
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

router.post('/mails/:id/tags', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { tag_id } = req.body;

    await query(
      `INSERT INTO mail_tags (mail_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [id, tag_id]
    );

    res.json({ message: 'Tag added successfully' });
  } catch (error) {
    console.error('Error adding tag:', error);
    res.status(500).json({ error: 'Failed to add tag' });
  }
});

router.delete('/mails/:id/tags/:tag_id', async (req: Request, res: Response) => {
  try {
    const { id, tag_id } = req.params;

    await query(`DELETE FROM mail_tags WHERE mail_id = $1 AND tag_id = $2`, [id, tag_id]);

    res.json({ message: 'Tag removed successfully' });
  } catch (error) {
    console.error('Error removing tag:', error);
    res.status(500).json({ error: 'Failed to remove tag' });
  }
});

export default router;
