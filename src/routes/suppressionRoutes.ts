import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../permissions/requirePermission';
import { badRequest, notFound } from '../utils/channelPlatform';
import {
  listSuppressions,
  removeSuppression,
  SuppressionReason,
  upsertSuppression,
} from '../services/suppressionService';

const router = Router();
router.use(authenticate);

router.get('/', requirePermission('OUTBOUND_VIEW'), async (req: AuthRequest, res: Response) => {
  try {
    const rows = await listSuppressions({
      tenantId: req.user!.tenantId,
      q: req.query.q ? String(req.query.q) : undefined,
      reason: req.query.reason ? String(req.query.reason) : undefined,
      limit: Number(req.query.limit) || 100,
      offset: Number(req.query.offset) || 0,
    });
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Engelleme listesi alınamadı' });
  }
});

router.post('/', requirePermission('EMAIL_SEND'), async (req: AuthRequest, res: Response) => {
  try {
    const email = String(req.body.email || '').trim();
    const reason = String(req.body.reason || 'ADMIN_BLOCKED') as SuppressionReason;
    if (!email) return badRequest(res, 'E-posta gerekli');
    const row = await upsertSuppression({
      tenantId: req.user!.tenantId,
      email,
      reason,
      source: req.body.source || 'admin',
      campaignId: req.body.campaign_id ? Number(req.body.campaign_id) : null,
      createdBy: req.user!.userId,
    });
    res.status(201).json({ success: true, data: row });
  } catch (error: any) {
    res.status(error.status || 500).json({ success: false, error: error.message || 'Eklenemedi' });
  }
});

router.delete('/:id', requirePermission('EMAIL_SEND'), async (req: AuthRequest, res: Response) => {
  const row = await removeSuppression(req.user!.tenantId, Number(req.params.id));
  if (!row) return notFound(res);
  res.json({ success: true });
});

export default router;
