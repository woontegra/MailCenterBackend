import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../permissions/requirePermission';
import { badRequest, notFound } from '../utils/channelPlatform';
import {
  createSegment,
  deleteSegment,
  duplicateSegment,
  getSegment,
  listSegments,
  previewSegmentCount,
  updateSegment,
} from '../services/campaignSegmentService';

const router = Router();
router.use(authenticate);

router.get('/', requirePermission('OUTBOUND_VIEW'), async (req: AuthRequest, res: Response) => {
  try {
    res.json({ success: true, data: await listSegments(req.user!.tenantId) });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Segmentler alınamadı' });
  }
});

router.post('/', requirePermission('EMAIL_SEND'), async (req: AuthRequest, res: Response) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return badRequest(res, 'Segment adı gerekli');
    const row = await createSegment({
      tenantId: req.user!.tenantId,
      userId: req.user!.userId,
      name,
      description: req.body.description || null,
      filters: req.body.filters || {},
    });
    res.status(201).json({ success: true, data: row });
  } catch (error: any) {
    res.status(error.code === '23505' ? 409 : 500).json({
      success: false,
      error: error.code === '23505' ? 'Bu isimde segment var' : 'Segment oluşturulamadı',
    });
  }
});

router.get('/:id', requirePermission('OUTBOUND_VIEW'), async (req: AuthRequest, res: Response) => {
  const row = await getSegment(req.user!.tenantId, Number(req.params.id));
  if (!row) return notFound(res);
  res.json({ success: true, data: row });
});

router.patch('/:id', requirePermission('EMAIL_SEND'), async (req: AuthRequest, res: Response) => {
  try {
    const row = await updateSegment(req.user!.tenantId, Number(req.params.id), req.body);
    if (!row) return notFound(res);
    res.json({ success: true, data: row });
  } catch (error: any) {
    res.status(error.code === '23505' ? 409 : 500).json({
      success: false,
      error: error.code === '23505' ? 'Bu isimde segment var' : 'Segment güncellenemedi',
    });
  }
});

router.post('/:id/duplicate', requirePermission('EMAIL_SEND'), async (req: AuthRequest, res: Response) => {
  const row = await duplicateSegment(req.user!.tenantId, Number(req.params.id), req.user!.userId);
  if (!row) return notFound(res);
  res.status(201).json({ success: true, data: row });
});

router.post('/:id/preview', requirePermission('OUTBOUND_VIEW'), async (req: AuthRequest, res: Response) => {
  const row = await getSegment(req.user!.tenantId, Number(req.params.id));
  if (!row) return notFound(res);
  const preview = await previewSegmentCount(req.user!.tenantId, row.filters || {});
  res.json({ success: true, data: preview });
});

router.delete('/:id', requirePermission('EMAIL_SEND'), async (req: AuthRequest, res: Response) => {
  const row = await deleteSegment(req.user!.tenantId, Number(req.params.id));
  if (!row) return notFound(res);
  res.json({ success: true });
});

export default router;
