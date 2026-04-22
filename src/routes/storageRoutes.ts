import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { query } from '../config/database';

const router = Router();

router.use(authenticate);

router.get('/usage', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;

    const result = await query(
      `SELECT t.storage_used_mb, t.storage_limit_mb, p.storage_limit_mb as plan_limit
       FROM tenants t
       LEFT JOIN subscriptions s ON t.id = s.tenant_id AND s.status = 'active'
       LEFT JOIN plans p ON s.plan_id = p.id
       WHERE t.id = $1`,
      [tenantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const usage = result.rows[0];
    const percentUsed = (usage.storage_used_mb / usage.storage_limit_mb) * 100;

    res.json({
      used_mb: usage.storage_used_mb,
      limit_mb: usage.storage_limit_mb,
      percent_used: Math.round(percentUsed),
      available_mb: usage.storage_limit_mb - usage.storage_used_mb,
    });
  } catch (error: any) {
    console.error('Get storage usage error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/cleanup', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { older_than_days = 90 } = req.body;

    const deletedMails = await query(
      `DELETE FROM mails 
       WHERE tenant_id = $1 AND date < NOW() - INTERVAL '${older_than_days} days'
       RETURNING size_bytes`,
      [tenantId]
    );

    let freedSpace = 0;
    for (const mail of deletedMails.rows) {
      freedSpace += mail.size_bytes || 0;
    }

    const freedSpaceMB = freedSpace / (1024 * 1024);

    await query(
      'UPDATE tenants SET storage_used_mb = GREATEST(0, storage_used_mb - $1) WHERE id = $2',
      [freedSpaceMB, tenantId]
    );

    res.json({
      deleted_count: deletedMails.rows.length,
      freed_space_mb: Math.round(freedSpaceMB * 100) / 100,
    });
  } catch (error: any) {
    console.error('Cleanup error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
