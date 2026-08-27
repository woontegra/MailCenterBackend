import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import {
  TRACKING_PIXEL_GIF,
  resolveTrackingToken,
} from '../services/emailTrackingTokenService';
import {
  recordClickEvent,
  recordDownloadEvent,
  recordOpenEvent,
  recordSiteEvent,
} from '../services/emailTrackingEventService';
import {
  resolveClickDestination,
  resolveDownloadFile,
} from '../services/emailTrackingInjectService';
import { S3Service } from '../services/s3Service';
import { buildSiteTrackingSnippet } from '../services/campaignAnalyticsService';
import { getTrackingBaseUrl } from '../services/emailTrackingTokenService';

const router = Router();
const s3 = new S3Service();

const trackingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many tracking requests',
});

router.use(trackingLimiter);

router.get('/mc-track.js', (_req, res) => {
  res.type('application/javascript').send(buildSiteTrackingSnippet(getTrackingBaseUrl()));
});

router.get('/o/:token', async (req, res) => {
  try {
    const key = await resolveTrackingToken(String(req.params.token || ''));
    if (key && key.purpose === 'OPEN') {
      await recordOpenEvent({
        key: key as any,
        userAgent: req.get('user-agent'),
        ip: req.ip,
      });
    }
  } catch {
    /* always return pixel */
  }
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Content-Type', 'image/gif');
  res.send(TRACKING_PIXEL_GIF);
});

router.get('/c/:token', async (req, res) => {
  const token = String(req.params.token || '');
  const key = await resolveTrackingToken(token);
  if (!key || key.purpose !== 'CLICK' || !key.purpose_ref_id) {
    return res.status(404).type('text/plain').send('Bağlantı bulunamadı');
  }

  await recordClickEvent({
    key: key as any,
    userAgent: req.get('user-agent'),
    ip: req.ip,
  });

  const destination = await resolveClickDestination({
    tenantId: Number(key.tenant_id),
    linkId: Number(key.purpose_ref_id),
  });
  if (!destination || !/^https?:\/\//i.test(destination)) {
    return res.status(404).type('text/plain').send('Hedef bağlantı bulunamadı');
  }

  let finalUrl = destination;
  try {
    const { query } = await import('../config/database');
    const { getOrCreateTrackingKey } = await import('../services/emailTrackingTokenService');
    const settingsRes = await query(
      `SELECT track_site, utm_source, utm_medium, utm_campaign
       FROM campaign_tracking_settings WHERE campaign_id = $1 AND tenant_id = $2`,
      [key.campaign_id, key.tenant_id]
    );
    const settings = settingsRes.rows[0];
    const u = new URL(destination);
    if (settings?.utm_source) u.searchParams.set('utm_source', settings.utm_source);
    if (settings?.utm_medium) u.searchParams.set('utm_medium', settings.utm_medium);
    if (settings?.utm_campaign) u.searchParams.set('utm_campaign', settings.utm_campaign);
    if (settings?.track_site) {
      const siteKey = await getOrCreateTrackingKey({
        tenantId: Number(key.tenant_id),
        campaignId: Number(key.campaign_id),
        campaignRecipientId: Number(key.campaign_recipient_id),
        outboundMessageId: key.outbound_message_id,
        purpose: 'SITE',
      });
      u.searchParams.set('mc_at', siteKey.token);
    }
    finalUrl = u.toString();
  } catch {
    finalUrl = destination;
  }

  return res.redirect(302, finalUrl);
});

router.get('/d/:token', async (req, res) => {
  const token = String(req.params.token || '');
  const key = await resolveTrackingToken(token);
  if (!key || key.purpose !== 'DOWNLOAD' || !key.purpose_ref_id) {
    return res.status(404).type('text/plain').send('Dosya bulunamadı');
  }

  const file = await resolveDownloadFile({
    tenantId: Number(key.tenant_id),
    fileId: Number(key.purpose_ref_id),
  });
  if (!file) {
    return res.status(404).type('text/plain').send('Dosya erişime kapalı');
  }

  await recordDownloadEvent({
    key: key as any,
    userAgent: req.get('user-agent'),
    ip: req.ip,
  });

  if (!s3.isConfigured()) {
    return res.status(503).type('text/plain').send('Dosya depolama yapılandırılmamış');
  }

  try {
    const obj = await s3.getObjectBuffer(file.storage_key);
    res.setHeader('Content-Type', file.content_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${file.file_name}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(obj);
  } catch {
    return res.status(404).type('text/plain').send('Dosya okunamadı');
  }
});

router.post('/site', async (req, res) => {
  const token = String(req.body?.token || '');
  const eventName = String(req.body?.event || req.body?.event_name || '').trim();
  const dedupeId = String(req.body?.dedupe_id || req.body?.dedupeId || '').trim() || undefined;

  if (!token || !eventName) {
    return res.status(400).json({ success: false, error: 'Geçersiz istek' });
  }

  const key = await resolveTrackingToken(token);
  if (!key || key.purpose !== 'SITE') {
    return res.status(404).json({ success: false, error: 'Geçersiz attribution' });
  }

  const allowed = [
    'page_viewed',
    'page_view',
    'demo_form_opened',
    'demo_submitted',
    'purchase_completed',
    'conversion',
  ];
  if (!allowed.includes(eventName.toLowerCase()) && !eventName.startsWith('custom_')) {
    return res.status(400).json({ success: false, error: 'Desteklenmeyen olay' });
  }

  await recordSiteEvent({
    tokenKey: key as any,
    eventName,
    dedupeId,
  });

  return res.json({ success: true });
});

export default router;
