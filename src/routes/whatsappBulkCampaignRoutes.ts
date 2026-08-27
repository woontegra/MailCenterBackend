import { Router, Response } from 'express';
import multer from 'multer';
import { authenticate, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../permissions/requirePermission';
import { badRequest, notFound } from '../utils/channelPlatform';
import {
  buildWhatsAppBulkSampleCsv,
  cancelCampaign,
  exportWhatsAppCampaignResults,
  launchWhatsAppBulkCampaign,
  listWhatsAppCampaignRecipients,
  listWhatsAppCampaigns,
  pauseCampaign,
  previewWhatsAppBulkCampaign,
  previewWhatsAppBulkImport,
  resumeCampaign,
} from '../services/whatsappBulkCampaignService';
import { getCampaignForTenant } from '../services/campaignService';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.use(authenticate);
router.use(requirePermission('WHATSAPP_SEND'));

router.get('/sample-csv', (_req: AuthRequest, res: Response) => {
  const buf = buildWhatsAppBulkSampleCsv();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="whatsapp-toplu-ornek.csv"');
  res.send(buf);
});

router.get('/', requirePermission('OUTBOUND_VIEW'), async (req: AuthRequest, res: Response) => {
  try {
    const brandId = req.query.brand_id ? Number(req.query.brand_id) : undefined;
    const rows = await listWhatsAppCampaigns(req.user!.tenantId, {
      brand_id: brandId,
      limit: Math.min(50, Number(req.query.limit) || 20),
    });
    res.json({ success: true, data: rows });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Kampanyalar alınamadı' });
  }
});

router.get('/:id', requirePermission('OUTBOUND_VIEW'), async (req: AuthRequest, res: Response) => {
  try {
    const row = await getCampaignForTenant(req.user!.tenantId, Number(req.params.id));
    if (!row || String(row.channel_type || '').toUpperCase() !== 'WHATSAPP') {
      return notFound(res);
    }
    res.json({ success: true, data: row });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Kampanya alınamadı' });
  }
});

router.get(
  '/:id/recipients',
  requirePermission('OUTBOUND_VIEW'),
  async (req: AuthRequest, res: Response) => {
    try {
      const limit = Math.min(500, Number(req.query.limit) || 100);
      const offset = Number(req.query.offset) || 0;
      const rows = await listWhatsAppCampaignRecipients(
        req.user!.tenantId,
        Number(req.params.id),
        limit,
        offset
      );
      if (!rows) return notFound(res);
      res.json({ success: true, data: rows });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Alıcılar alınamadı' });
    }
  }
);

router.get(
  '/:id/export',
  requirePermission('OUTBOUND_VIEW'),
  async (req: AuthRequest, res: Response) => {
    try {
      const buf = await exportWhatsAppCampaignResults(
        req.user!.tenantId,
        Number(req.params.id)
      );
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="whatsapp-kampanya-${req.params.id}.xlsx"`
      );
      res.send(buf);
    } catch (error: any) {
      res.status(error.status || 500).json({
        success: false,
        error: error.message || 'Dışa aktarma başarısız',
      });
    }
  }
);

router.post('/preview-recipients', async (req: AuthRequest, res: Response) => {
  try {
    const brandId = Number(req.body.brand_id ?? req.body.brandId);
    const channelConnectionId = Number(
      req.body.channel_connection_id ?? req.body.channelConnectionId
    );
    const templateId = Number(req.body.template_id ?? req.body.templateId);
    if (!brandId || !channelConnectionId || !templateId) {
      return badRequest(res, 'Marka, WhatsApp hattı ve şablon zorunludur');
    }
    const data = await previewWhatsAppBulkCampaign({
      tenantId: req.user!.tenantId,
      brandId,
      channelConnectionId,
      templateId,
      variableMapping: req.body.variable_mapping ?? req.body.variableMapping ?? {},
      contactIds: Array.isArray(req.body.contact_ids ?? req.body.contactIds)
        ? (req.body.contact_ids ?? req.body.contactIds).map(Number).filter(Boolean)
        : undefined,
      phonesPaste: req.body.phones_paste ?? req.body.phonesPaste,
      rows: req.body.rows,
    });
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Önizleme başarısız',
      summary: error.summary,
    });
  }
});

router.post(
  '/preview-import',
  upload.single('file'),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.file) return badRequest(res, 'Dosya gerekli');
      const brandId = Number(req.body.brand_id ?? req.body.brandId);
      const channelConnectionId = Number(
        req.body.channel_connection_id ?? req.body.channelConnectionId
      );
      const templateId = Number(req.body.template_id ?? req.body.templateId);
      if (!brandId || !channelConnectionId || !templateId) {
        return badRequest(res, 'Marka, WhatsApp hattı ve şablon zorunludur');
      }
      const mapping = req.body.mapping ? JSON.parse(String(req.body.mapping)) : req.body;
      const data = await previewWhatsAppBulkImport({
        tenantId: req.user!.tenantId,
        brandId,
        channelConnectionId,
        templateId,
        variableMapping: req.body.variable_mapping
          ? JSON.parse(String(req.body.variable_mapping))
          : req.body.variableMapping || {},
        file: req.file,
        mapping,
      });
      res.json({ success: true, data });
    } catch (error: any) {
      res.status(error.status || 500).json({
        success: false,
        error: error.message || 'Dosya önizlenemedi',
      });
    }
  }
);

router.post('/launch', async (req: AuthRequest, res: Response) => {
  try {
    const brandId = Number(req.body.brand_id ?? req.body.brandId);
    const channelConnectionId = Number(
      req.body.channel_connection_id ?? req.body.channelConnectionId
    );
    const senderIdentityId = Number(
      req.body.sender_identity_id ?? req.body.senderIdentityId
    );
    const templateId = Number(req.body.template_id ?? req.body.templateId);
    const name = String(req.body.name || '').trim();
    if (!brandId || !channelConnectionId || !senderIdentityId || !templateId || !name) {
      return badRequest(res, 'Kampanya adı, marka, hat, gönderici ve şablon zorunludur');
    }
    const row = await launchWhatsAppBulkCampaign({
      tenantId: req.user!.tenantId,
      userId: req.user!.userId,
      name,
      brandId,
      channelConnectionId,
      senderIdentityId,
      templateId,
      variableMapping: req.body.variable_mapping ?? req.body.variableMapping ?? {},
      contactIds: Array.isArray(req.body.contact_ids ?? req.body.contactIds)
        ? (req.body.contact_ids ?? req.body.contactIds).map(Number).filter(Boolean)
        : undefined,
      phonesPaste: req.body.phones_paste ?? req.body.phonesPaste,
      rows: req.body.rows,
    });
    res.status(201).json({ success: true, data: row });
  } catch (error: any) {
    res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Toplu gönderim başlatılamadı',
      summary: error.summary,
    });
  }
});

router.post('/:id/pause', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await getCampaignForTenant(req.user!.tenantId, Number(req.params.id));
    if (!existing || String(existing.channel_type || '').toUpperCase() !== 'WHATSAPP') {
      return notFound(res);
    }
    const row = await pauseCampaign(req.user!.tenantId, Number(req.params.id));
    res.json({ success: true, data: row });
  } catch (error: any) {
    res.status(error.status || 500).json({ success: false, error: error.message || 'Duraklatılamadı' });
  }
});

router.post('/:id/resume', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await getCampaignForTenant(req.user!.tenantId, Number(req.params.id));
    if (!existing || String(existing.channel_type || '').toUpperCase() !== 'WHATSAPP') {
      return notFound(res);
    }
    const row = await resumeCampaign(req.user!.tenantId, Number(req.params.id));
    res.json({ success: true, data: row });
  } catch (error: any) {
    res.status(error.status || 500).json({ success: false, error: error.message || 'Devam ettirilemedi' });
  }
});

router.post('/:id/cancel', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await getCampaignForTenant(req.user!.tenantId, Number(req.params.id));
    if (!existing || String(existing.channel_type || '').toUpperCase() !== 'WHATSAPP') {
      return notFound(res);
    }
    const row = await cancelCampaign(req.user!.tenantId, Number(req.params.id));
    res.json({ success: true, data: row });
  } catch (error: any) {
    res.status(error.status || 500).json({ success: false, error: error.message || 'İptal edilemedi' });
  }
});

export default router;
