import { Router, Response } from 'express';
import multer from 'multer';
import { authenticate, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../permissions/requirePermission';
import { badRequest, notFound } from '../utils/channelPlatform';
import {
  cancelCampaign,
  createCampaignDraft,
  duplicateCampaign,
  getCampaignForTenant,
  launchCampaign,
  listCampaignRecipients,
  listCampaigns,
  pauseCampaign,
  resumeCampaign,
  sendCampaignTestEmail,
  updateCampaignDraft,
  validateCampaignForLaunch,
} from '../services/campaignService';
import { AudienceConfig, previewAudienceCount } from '../services/campaignRecipientResolver';
import {
  applyRecipientImport,
  parseRecipientFile,
  previewRecipientImport,
} from '../services/campaignImportService';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});
router.use(authenticate);

router.get('/', requirePermission('OUTBOUND_VIEW'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { brand_id, q } = req.query;
    const rows = await listCampaigns(tenantId, {
      brand_id: brand_id ? Number(brand_id) : undefined,
      q: q ? String(q) : undefined,
    });
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Error listing campaigns:', error);
    res.status(500).json({ success: false, error: 'Kampanyalar alınamadı' });
  }
});

router.post('/', requirePermission('EMAIL_SEND'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const name = String(req.body.name || '').trim();
    if (!name) return badRequest(res, 'Kampanya adı gerekli');
    const row = await createCampaignDraft({
      tenantId,
      userId,
      name,
      brandId: req.body.brand_id ?? req.body.brandId ?? null,
      timezone: req.body.timezone || req.body.tz || 'Europe/Istanbul',
    });
    res.status(201).json({ success: true, data: row });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({ success: false, error: error.message || 'Kampanya oluşturulamadı' });
  }
});

router.get('/:id', requirePermission('OUTBOUND_VIEW'), async (req: AuthRequest, res: Response) => {
  try {
    const row = await getCampaignForTenant(req.user!.tenantId, Number(req.params.id));
    if (!row) return notFound(res);
    res.json({ success: true, data: row });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Kampanya alınamadı' });
  }
});

router.patch('/:id', requirePermission('EMAIL_SEND'), async (req: AuthRequest, res: Response) => {
  try {
    const row = await updateCampaignDraft(req.user!.tenantId, Number(req.params.id), req.body);
    if (!row) return notFound(res);
    res.json({ success: true, data: row });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({ success: false, error: error.message || 'Güncellenemedi' });
  }
});

router.post('/:id/duplicate', requirePermission('EMAIL_SEND'), async (req: AuthRequest, res: Response) => {
  try {
    const row = await duplicateCampaign(
      req.user!.tenantId,
      Number(req.params.id),
      req.user!.userId
    );
    if (!row) return notFound(res);
    res.status(201).json({ success: true, data: row });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Kopyalanamadı' });
  }
});

router.post('/preview-audience', requirePermission('EMAIL_SEND'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const audience = (req.body.audience_config ?? req.body.audienceConfig ?? req.body) as AudienceConfig;
    const brandId = req.body.brand_id ?? req.body.brandId ?? null;
    const preview = await previewAudienceCount({
      tenantId,
      brandId: brandId ? Number(brandId) : null,
      audience,
    });
    res.json({ success: true, data: preview });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Önizleme başarısız' });
  }
});

router.post(
  '/:id/imports/preview',
  requirePermission('EMAIL_SEND'),
  upload.single('file'),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.file) return badRequest(res, 'Dosya gerekli');
      const mapping = req.body.mapping ? JSON.parse(String(req.body.mapping)) : req.body;
      const parsed = parseRecipientFile(req.file);
      const preview = await previewRecipientImport({
        tenantId: req.user!.tenantId,
        campaignId: Number(req.params.id),
        userId: req.user!.userId,
        filename: req.file.originalname,
        rows: parsed.rows,
        mapping,
      });
      res.json({ success: true, data: { ...preview, headers: parsed.headers } });
    } catch (error: any) {
      res.status(error.status || 500).json({
        success: false,
        error: error.message || 'Dosya önizlenemedi',
      });
    }
  }
);

router.post('/:id/imports/:importId/apply', requirePermission('EMAIL_SEND'), async (req: AuthRequest, res: Response) => {
  try {
    const result = await applyRecipientImport({
      tenantId: req.user!.tenantId,
      userId: req.user!.userId,
      importId: Number(req.params.importId),
      options: {
        update_existing: Boolean(req.body.update_existing),
        save_new_contacts: Boolean(req.body.save_new_contacts),
        snapshot_only: Boolean(req.body.snapshot_only),
      },
    });
    if (!result) return notFound(res);

    await updateCampaignDraft(req.user!.tenantId, Number(req.params.id), {
      audience_config: {
        mode: 'IMPORT',
        import_id: Number(req.params.importId),
      },
    });

    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(error.status || 500).json({ success: false, error: error.message || 'İçe aktarma uygulanamadı' });
  }
});

router.post('/:id/validate', requirePermission('EMAIL_SEND'), async (req: AuthRequest, res: Response) => {
  try {
    const result = await validateCampaignForLaunch(req.user!.tenantId, Number(req.params.id));
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Doğrulama başarısız' });
  }
});

router.post('/:id/test-send', requirePermission('EMAIL_SEND'), async (req: AuthRequest, res: Response) => {
  try {
    const toEmail = String(req.body.to ?? req.body.email ?? '').trim();
    if (!toEmail) return badRequest(res, 'Test e-posta adresi gerekli');
    const result = await sendCampaignTestEmail({
      tenantId: req.user!.tenantId,
      userId: req.user!.userId,
      campaignId: Number(req.params.id),
      toEmail,
      includeTestPrefix: req.body.includeTestPrefix !== false,
    });
    res.json({ success: true, data: result });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({ success: false, error: error.message || 'Test gönderilemedi' });
  }
});

router.post('/:id/launch', requirePermission('EMAIL_SEND'), async (req: AuthRequest, res: Response) => {
  try {
    const sendNow = req.body.send_now ?? req.body.sendNow ?? true;
    const scheduledRaw = req.body.scheduled_at ?? req.body.scheduledAt;
    const scheduledAt = scheduledRaw ? new Date(String(scheduledRaw)) : null;
    if (!sendNow && scheduledAt && Number.isNaN(scheduledAt.getTime())) {
      return badRequest(res, 'Geçersiz planlama zamanı');
    }
    const row = await launchCampaign({
      tenantId: req.user!.tenantId,
      campaignId: Number(req.params.id),
      sendNow: Boolean(sendNow),
      scheduledAt: sendNow ? null : scheduledAt,
    });
    res.json({ success: true, data: row });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      error: error.message || 'Kampanya başlatılamadı',
      issues: error.issues,
    });
  }
});

router.post('/:id/pause', requirePermission('EMAIL_SEND'), async (req: AuthRequest, res: Response) => {
  try {
    const row = await pauseCampaign(req.user!.tenantId, Number(req.params.id));
    if (!row) return notFound(res);
    res.json({ success: true, data: row });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({ success: false, error: error.message || 'Duraklatılamadı' });
  }
});

router.post('/:id/resume', requirePermission('EMAIL_SEND'), async (req: AuthRequest, res: Response) => {
  try {
    const row = await resumeCampaign(req.user!.tenantId, Number(req.params.id));
    if (!row) return notFound(res);
    res.json({ success: true, data: row });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({ success: false, error: error.message || 'Devam ettirilemedi' });
  }
});

router.post('/:id/cancel', requirePermission('EMAIL_SEND'), async (req: AuthRequest, res: Response) => {
  try {
    const row = await cancelCampaign(req.user!.tenantId, Number(req.params.id));
    if (!row) return notFound(res);
    res.json({ success: true, data: row });
  } catch (error: any) {
    const status = error.status || 500;
    res.status(status).json({ success: false, error: error.message || 'İptal edilemedi' });
  }
});

router.get('/:id/recipients', requirePermission('OUTBOUND_VIEW'), async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const offset = Number(req.query.offset) || 0;
    const rows = await listCampaignRecipients(
      req.user!.tenantId,
      Number(req.params.id),
      limit,
      offset
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Alıcılar alınamadı' });
  }
});

export default router;
