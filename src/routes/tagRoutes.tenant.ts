import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();

router.use(authenticate);

router.get('/tags', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const result = await query(
      'SELECT * FROM tags WHERE tenant_id = $1 ORDER BY name',
      [tenantId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching tags:', error);
    res.status(500).json({ error: 'Failed to fetch tags' });
  }
});

router.post('/tags', async (req: AuthRequest, res: Response) => {
  try {
    const { name, color } = req.body;
    const tenantId = req.user!.tenantId;

    if (!name) {
      return res.status(400).json({ error: 'Tag name is required' });
    }

    const result = await query(
      `INSERT INTO tags (name, color, tenant_id) VALUES ($1, $2, $3) RETURNING *`,
      [name, color || '#6B7280', tenantId]
    );

    res.status(201).json(result.rows[0]);
  } catch (error: any) {
    console.error('Error creating tag:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Tag already exists for this tenant' });
    }
    res.status(500).json({ error: 'Failed to create tag' });
  }
});

export default router;
