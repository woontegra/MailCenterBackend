import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { badRequest, notFound } from '../utils/channelPlatform';
import {
  cancelOutboundMessage,
  getOutboundMessageForTenant,
  listOutboundAttempts,
  listOutboundMessages,
  resetFailedForRetry,
} from '../services/outboundMessageService';
import { enqueueOutboundSend } from '../queues/mailQueue';
import { isMailQueueEnabled, pingRedis, allowSyncSendFallback } from '../config/redis';
import { processOutboundEmailMessage } from '../services/outboundSendProcessor';
import { processOutboundSmsMessage } from '../services/outboundSmsProcessor';
import { processOutboundWhatsAppMessage } from '../services/outboundWhatsAppProcessor';
import { requirePermission } from '../permissions/requirePermission';

const router = Router();
router.use(authenticate);
router.use(requirePermission('OUTBOUND_VIEW'));

function publicMessage(row: any) {
  const recipients = row.recipient_data || {};
  const previewSource =
    row.channel_type === 'SMS'
      ? row.message_content || row.plain_text_content || ''
      : row.plain_text_content || row.html_content || '';
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    brand_id: row.brand_id,
    brand_name: row.brand_name,
    channel_type: row.channel_type,
    sender_identity_id: row.sender_identity_id,
    sender_display_name: row.sender_display_name,
    sender_value: row.sender_value,
    template_id: row.template_id,
    draft_id: row.draft_id,
    to: recipients.to || recipients.phone || null,
    cc: recipients.cc || null,
    subject: row.subject,
    content_preview: String(previewSource)
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160),
    segment_count: recipients.segment_count ?? null,
    encoding: recipients.encoding ?? null,
    character_count: recipients.character_count ?? null,
    status: row.status,
    attempt_count: row.attempt_count,
    last_error_code: row.last_error_code,
    last_error_message: row.last_error_message,
    provider_message_id: row.provider_message_id,
    queued_at: row.queued_at,
    scheduled_at: row.scheduled_at,
    sent_at: row.sent_at,
    failed_at: row.failed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const rows = await listOutboundMessages(req.user!.tenantId, 50);
    res.json({ success: true, data: rows.map(publicMessage) });
  } catch (error) {
    console.error('Error listing outbound messages:', error);
    res.status(500).json({ success: false, error: 'Gönderimler alınamadı' });
  }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const row = await getOutboundMessageForTenant(Number(req.params.id), req.user!.tenantId);
    if (!row) return notFound(res);
    res.json({ success: true, data: publicMessage(row) });
  } catch (error) {
    console.error('Error fetching outbound message:', error);
    res.status(500).json({ success: false, error: 'Gönderim alınamadı' });
  }
});

router.get('/:id/attempts', async (req: AuthRequest, res: Response) => {
  try {
    const row = await getOutboundMessageForTenant(Number(req.params.id), req.user!.tenantId);
    if (!row) return notFound(res);
    const attempts = await listOutboundAttempts(row.id, req.user!.tenantId);
    res.json({
      success: true,
      data: attempts.map((a: any) => ({
        id: a.id,
        attempt_number: a.attempt_number,
        status: a.status,
        provider: a.provider,
        error_code: a.error_code,
        safe_error_message: a.safe_error_message,
        started_at: a.started_at,
        completed_at: a.completed_at,
      })),
    });
  } catch (error) {
    console.error('Error listing attempts:', error);
    res.status(500).json({ success: false, error: 'Denemeler alınamadı' });
  }
});

router.post('/:id/cancel', async (req: AuthRequest, res: Response) => {
  try {
    const cancelled = await cancelOutboundMessage(Number(req.params.id), req.user!.tenantId);
    if (!cancelled) {
      const existing = await getOutboundMessageForTenant(
        Number(req.params.id),
        req.user!.tenantId
      );
      if (!existing) return notFound(res);
      return badRequest(res, 'Yalnızca kuyruktaki veya zamanlanmış gönderimler iptal edilebilir');
    }
    res.json({ success: true, data: publicMessage(cancelled) });
  } catch (error) {
    console.error('Error cancelling outbound message:', error);
    res.status(500).json({ success: false, error: 'İptal edilemedi' });
  }
});

router.post('/:id/retry', requirePermission('OUTBOUND_RETRY'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const reset = await resetFailedForRetry(Number(req.params.id), tenantId);
    if (!reset) {
      const existing = await getOutboundMessageForTenant(Number(req.params.id), tenantId);
      if (!existing) return notFound(res);
      return badRequest(res, 'Yalnızca başarısız gönderimler yeniden denenebilir');
    }

    if (isMailQueueEnabled()) {
      const ping = await pingRedis();
      if (!ping.ok) {
        return res.status(503).json({ success: false, error: 'Gönderim kuyruğu kullanılamıyor' });
      }
      await enqueueOutboundSend(reset.id, tenantId, 0);
      return res.json({
        success: true,
        queued: true,
        data: publicMessage(reset),
        message: 'Yeniden kuyruğa alındı',
      });
    }

    if (!allowSyncSendFallback()) {
      return res.status(503).json({ success: false, error: 'Senkron yeniden deneme kapalı' });
    }

    const result =
      reset.channel_type === 'SMS'
        ? await processOutboundSmsMessage(reset.id, tenantId)
        : reset.channel_type === 'WHATSAPP'
          ? await processOutboundWhatsAppMessage(reset.id, tenantId)
          : await processOutboundEmailMessage(reset.id, tenantId);
    const fresh = await getOutboundMessageForTenant(reset.id, tenantId);
    return res.json({
      success: result.outcome === 'sent' || result.outcome === 'delayed',
      data: fresh ? publicMessage(fresh) : publicMessage(reset),
      outcome: result.outcome,
    });
  } catch (error) {
    console.error('Error retrying outbound message:', error);
    res.status(500).json({ success: false, error: 'Yeniden deneme başarısız' });
  }
});

export default router;
