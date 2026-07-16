import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../permissions/requirePermission';
import { badRequest, conflict, notFound, slugify } from '../utils/channelPlatform';

const router = Router();
router.use(authenticate);

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT * FROM brands
       WHERE tenant_id = $1
       ORDER BY created_at DESC`,
      [req.user!.tenantId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error listing brands:', error);
    res.status(500).json({ error: 'Failed to list brands' });
  }
});

router.post('/', requirePermission('BRAND_MANAGE'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { enforceCountQuota, afterCountResourceCreated } = await import('../utils/quotaGuards');
    if (!(await enforceCountQuota(res, tenantId, 'max_brands'))) return;

    const { name, slug, domain, logo_url, accent_color, is_active = true } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return badRequest(res, 'Brand name is required');
    }

    const finalSlug = slugify(slug || name);
    if (!finalSlug) {
      return badRequest(res, 'Valid brand slug is required');
    }

    const result = await query(
      `INSERT INTO brands (tenant_id, name, slug, domain, logo_url, accent_color, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        tenantId,
        name.trim(),
        finalSlug,
        domain || null,
        logo_url || null,
        accent_color || null,
        Boolean(is_active),
      ]
    );

    await query(
      `INSERT INTO domain_health_checks (tenant_id, brand_id, domain)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, brand_id) DO NOTHING`,
      [tenantId, result.rows[0].id, domain || null]
    );

    await afterCountResourceCreated(tenantId);
    res.status(201).json(result.rows[0]);
  } catch (error: any) {
    if (error.code === '23505') {
      return conflict(res, 'Brand slug or domain already exists in this tenant');
    }
    console.error('Error creating brand:', error);
    res.status(500).json({ error: 'Failed to create brand' });
  }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT * FROM brands WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.user!.tenantId]
    );
    if (result.rows.length === 0) return notFound(res);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching brand:', error);
    res.status(500).json({ error: 'Failed to fetch brand' });
  }
});

router.patch('/:id', requirePermission('BRAND_MANAGE'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const existing = await query(
      `SELECT * FROM brands WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId]
    );
    if (existing.rows.length === 0) return notFound(res);

    const current = existing.rows[0];
    const {
      name = current.name,
      slug = current.slug,
      domain = current.domain,
      logo_url = current.logo_url,
      accent_color = current.accent_color,
      is_active = current.is_active,
    } = req.body;

    const finalSlug = slugify(String(slug));
    if (!finalSlug) {
      return badRequest(res, 'Valid brand slug is required');
    }

    const result = await query(
      `UPDATE brands
       SET name = $1, slug = $2, domain = $3, logo_url = $4, accent_color = $5,
           is_active = $6, updated_at = CURRENT_TIMESTAMP
       WHERE id = $7 AND tenant_id = $8
       RETURNING *`,
      [
        String(name).trim(),
        finalSlug,
        domain || null,
        logo_url || null,
        accent_color || null,
        Boolean(is_active),
        req.params.id,
        tenantId,
      ]
    );

    res.json(result.rows[0]);
  } catch (error: any) {
    if (error.code === '23505') {
      return conflict(res, 'Brand slug or domain already exists in this tenant');
    }
    console.error('Error updating brand:', error);
    res.status(500).json({ error: 'Failed to update brand' });
  }
});

router.delete('/:id', requirePermission('BRAND_MANAGE'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const existing = await query(
      `SELECT id FROM brands WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId]
    );
    if (existing.rows.length === 0) return notFound(res);

    const linked = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM channel_connections WHERE brand_id = $1 AND tenant_id = $2) AS connections,
         (SELECT COUNT(*)::int FROM sender_identities WHERE brand_id = $1 AND tenant_id = $2) AS senders`,
      [req.params.id, tenantId]
    );

    const counts = linked.rows[0];
    if (counts.connections > 0 || counts.senders > 0) {
      return conflict(
        res,
        'Brand has linked channel connections or sender identities and cannot be deleted'
      );
    }

    await query(`DELETE FROM brands WHERE id = $1 AND tenant_id = $2`, [
      req.params.id,
      tenantId,
    ]);

    res.json({ message: 'Brand deleted successfully' });
  } catch (error: any) {
    if (error.code === '23503' || error.code === '23001') {
      return conflict(res, 'Brand has linked records and cannot be deleted');
    }
    console.error('Error deleting brand:', error);
    res.status(500).json({ error: 'Failed to delete brand' });
  }
});

export default router;
