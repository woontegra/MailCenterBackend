import { Router, Request, Response } from 'express';
import { query } from '../config/database';

const router = Router();

router.get('/tags', async (req: Request, res: Response) => {
  try {
    const result = await query('SELECT * FROM tags ORDER BY name');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching tags:', error);
    res.status(500).json({ error: 'Failed to fetch tags' });
  }
});

router.post('/tags', async (req: Request, res: Response) => {
  try {
    const { name, color } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Tag name is required' });
    }

    const result = await query(
      `INSERT INTO tags (name, color) VALUES ($1, $2) RETURNING *`,
      [name, color || '#6B7280']
    );

    res.status(201).json(result.rows[0]);
  } catch (error: any) {
    console.error('Error creating tag:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Tag already exists' });
    }
    res.status(500).json({ error: 'Failed to create tag' });
  }
});

export default router;
