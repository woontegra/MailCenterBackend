import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../permissions/requirePermission';
import { notFound } from '../utils/channelPlatform';
import { getCampaignForTenant } from '../services/campaignService';
import {
  exportCampaignSummaryXlsx,
  exportLinksXlsx,
  exportRecipientsXlsx,
  getCampaignAnalyticsSummary,
  getRecipientTimeline,
  listCampaignRecipientAnalytics,
  listDownloadReport,
  listLinkClickReport,
  saveFilteredRecipientsAsList,
} from '../services/campaignAnalyticsService';

const router = Router({ mergeParams: true });

router.use(authenticate);

async function assertCampaign(req: AuthRequest, campaignId: number) {
  const row = await getCampaignForTenant(req.user!.tenantId, campaignId);
  if (!row || String(row.channel_type || 'EMAIL').toUpperCase() !== 'EMAIL') {
    return null;
  }
  return row;
}

router.get('/analytics/summary', requirePermission('OUTBOUND_VIEW'), async (req: AuthRequest, res: Response) => {
  try {
    const campaignId = Number(req.params.id);
    const campaign = await assertCampaign(req, campaignId);
    if (!campaign) return notFound(res);
    const data = await getCampaignAnalyticsSummary(req.user!.tenantId, campaignId);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Rapor alınamadı' });
  }
});

router.get('/analytics/recipients', requirePermission('OUTBOUND_VIEW'), async (req: AuthRequest, res: Response) => {
  try {
    const campaignId = Number(req.params.id);
    const campaign = await assertCampaign(req, campaignId);
    if (!campaign) return notFound(res);
    const rows = await listCampaignRecipientAnalytics(req.user!.tenantId, campaignId, {
      filter: req.query.filter ? String(req.query.filter) : undefined,
      limit: Math.min(500, Number(req.query.limit) || 50),
      offset: Number(req.query.offset) || 0,
    });
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Alıcı raporu alınamadı' });
  }
});

router.get(
  '/analytics/recipients/:recipientId/timeline',
  requirePermission('OUTBOUND_VIEW'),
  async (req: AuthRequest, res: Response) => {
    try {
      const campaignId = Number(req.params.id);
      const campaign = await assertCampaign(req, campaignId);
      if (!campaign) return notFound(res);
      const rows = await getRecipientTimeline(
        req.user!.tenantId,
        campaignId,
        Number(req.params.recipientId)
      );
      res.json({ success: true, data: rows });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Zaman çizelgesi alınamadı' });
    }
  }
);

router.get('/analytics/links', requirePermission('OUTBOUND_VIEW'), async (req: AuthRequest, res: Response) => {
  try {
    const campaignId = Number(req.params.id);
    const campaign = await assertCampaign(req, campaignId);
    if (!campaign) return notFound(res);
    const rows = await listLinkClickReport(req.user!.tenantId, campaignId);
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Bağlantı raporu alınamadı' });
  }
});

router.get('/analytics/downloads', requirePermission('OUTBOUND_VIEW'), async (req: AuthRequest, res: Response) => {
  try {
    const campaignId = Number(req.params.id);
    const campaign = await assertCampaign(req, campaignId);
    if (!campaign) return notFound(res);
    const rows = await listDownloadReport(req.user!.tenantId, campaignId);
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Dosya raporu alınamadı' });
  }
});

router.post('/analytics/save-list', requirePermission('EMAIL_SEND'), async (req: AuthRequest, res: Response) => {
  try {
    const campaignId = Number(req.params.id);
    const campaign = await assertCampaign(req, campaignId);
    if (!campaign) return notFound(res);
    const result = await saveFilteredRecipientsAsList({
      tenantId: req.user!.tenantId,
      userId: req.user!.userId,
      campaignId,
      filter: String(req.body.filter || ''),
      listName: String(req.body.list_name || req.body.listName || '').trim(),
    });
    res.status(201).json({ success: true, data: result });
  } catch (error: any) {
    res.status(error.status || 500).json({ success: false, error: error.message || 'Liste oluşturulamadı' });
  }
});

router.get('/analytics/export/summary', requirePermission('OUTBOUND_VIEW'), async (req: AuthRequest, res: Response) => {
  try {
    const campaignId = Number(req.params.id);
    const buf = await exportCampaignSummaryXlsx(req.user!.tenantId, campaignId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="kampanya-ozet-${campaignId}.xlsx"`);
    res.send(buf);
  } catch (error: any) {
    res.status(error.status || 500).json({ success: false, error: error.message || 'Dışa aktarılamadı' });
  }
});

router.get('/analytics/export/recipients', requirePermission('OUTBOUND_VIEW'), async (req: AuthRequest, res: Response) => {
  try {
    const campaignId = Number(req.params.id);
    const buf = await exportRecipientsXlsx(
      req.user!.tenantId,
      campaignId,
      req.query.filter ? String(req.query.filter) : undefined
    );
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="kampanya-alicilar-${campaignId}.xlsx"`);
    res.send(buf);
  } catch (error: any) {
    res.status(error.status || 500).json({ success: false, error: error.message || 'Dışa aktarılamadı' });
  }
});

router.get('/analytics/export/links', requirePermission('OUTBOUND_VIEW'), async (req: AuthRequest, res: Response) => {
  try {
    const campaignId = Number(req.params.id);
    const buf = await exportLinksXlsx(req.user!.tenantId, campaignId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="kampanya-baglantilar-${campaignId}.xlsx"`);
    res.send(buf);
  } catch (error: any) {
    res.status(error.status || 500).json({ success: false, error: error.message || 'Dışa aktarılamadı' });
  }
});

export default router;
