import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { query } from '../config/database';
import { badRequest, notFound } from '../utils/channelPlatform';
import {
  resolveEligibleSmsSenderIdentity,
  respondSenderResolveError,
} from '../utils/senderIdentityAccess';
import { checkRecipientEligibility } from '../utils/recipientEligibility';
import { renderTemplateContent } from '../utils/templateRenderer';
import { sanitizeSmsPlainText, containsHtml } from '../sms/smsContent';
import { assertSmsLengthAllowed, analyzeSmsContent } from '../sms/smsSegmentCounter';
import {
  allowSyncSendFallback,
  isMailQueueEnabled,
  pingRedis,
} from '../config/redis';
import { createOutboundMessage } from '../services/outboundMessageService';
import { enqueueOutboundSend } from '../queues/mailQueue';
import { processOutboundSmsMessage } from '../services/outboundSmsProcessor';
import { getTenantDefaultCountryCode } from '../utils/contactNormalize';
import { requirePermission, forbidden } from '../permissions/requirePermission';
import { hasPermission } from '../permissions/permissionCatalog';

const router = Router();
router.use(authenticate);
router.use(requirePermission('SMS_SEND'));

async function resolveRecipientPhone(params: {
  tenantId: number;
  recipient?: string | null;
  contactPointId?: number | null;
  countryCode?: string | null;
}): Promise<{ ok: true; phone: string } | { ok: false; status: number; error: string }> {
  if (params.contactPointId) {
    const point = await query(
      `SELECT cp.value, cp.normalized_value, cp.channel_type, c.status AS contact_status
       FROM contact_points cp
       JOIN contacts c ON c.id = cp.contact_id AND c.tenant_id = cp.tenant_id
       WHERE cp.id = $1 AND cp.tenant_id = $2 AND cp.is_active = true`,
      [params.contactPointId, params.tenantId]
    );
    if (point.rows.length === 0) {
      return { ok: false, status: 404, error: 'Not found' };
    }
    const row = point.rows[0];
    if (row.channel_type !== 'SMS' && row.channel_type !== 'WHATSAPP') {
      return { ok: false, status: 400, error: 'İletişim noktası SMS için uygun değil' };
    }
    return { ok: true, phone: row.normalized_value || row.value };
  }

  if (!params.recipient || !String(params.recipient).trim()) {
    return { ok: false, status: 400, error: 'recipient veya contactPointId gerekli' };
  }

  return { ok: true, phone: String(params.recipient).trim() };
}

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;

    if (
      (req.body.conversationId || req.body.conversation_id) &&
      !hasPermission(req.user!.permissions || [], 'CONVERSATION_REPLY')
    ) {
      return forbidden(res, 'Konuşmaya yanıt için yetkiniz yok');
    }

    // Never accept provider secrets or free-form sender from client
    void req.body.username;
    void req.body.password;
    void req.body.msgheader;
    void req.body.sender;
    void req.body.from;

    const brandId = Number(req.body.brandId ?? req.body.brand_id);
    const senderIdentityId = Number(
      req.body.senderIdentityId ?? req.body.sender_identity_id
    );
    const templateId = req.body.templateId ?? req.body.template_id ?? null;
    const contactPointIdRaw = req.body.contactPointId ?? req.body.contact_point_id;
    const contactPointId = contactPointIdRaw ? Number(contactPointIdRaw) : null;
    const recipient = req.body.recipient ?? req.body.to ?? null;
    const templateVariables =
      req.body.templateVariables ?? req.body.template_variables ?? {};
    const idempotencyKey = String(
      req.body.idempotencyKey ?? req.body.idempotency_key ?? ''
    ).trim();
    let messageContent = req.body.messageContent ?? req.body.message ?? req.body.body ?? '';

    if (!brandId || !senderIdentityId) {
      return badRequest(res, 'brandId ve senderIdentityId zorunludur');
    }
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 191) {
      return badRequest(res, 'Geçerli idempotencyKey zorunludur (8-191 karakter)');
    }
    if (containsHtml(messageContent)) {
      return badRequest(res, 'SMS içeriği HTML olamaz');
    }

    const brand = await query(`SELECT id FROM brands WHERE id = $1 AND tenant_id = $2`, [
      brandId,
      tenantId,
    ]);
    if (brand.rows.length === 0) return notFound(res);

    let resolved;
    try {
      resolved = await resolveEligibleSmsSenderIdentity(senderIdentityId, tenantId, brandId);
    } catch (error: any) {
      return respondSenderResolveError(res, error);
    }
    if (!resolved) return notFound(res);

    const phoneResolved = await resolveRecipientPhone({
      tenantId,
      recipient,
      contactPointId,
      countryCode: req.body.country_code || null,
    });
    if (phoneResolved.ok === false) {
      if (phoneResolved.status === 404) return notFound(res);
      return badRequest(res, phoneResolved.error);
    }

    const eligibility = await checkRecipientEligibility({
      tenantId,
      channelType: 'SMS',
      value: phoneResolved.phone,
      brandId,
      countryCode: req.body.country_code || (await getTenantDefaultCountryCode(tenantId)),
      strictPreference: true,
    });
    if (!eligibility.eligible) {
      return badRequest(res, eligibility.reason || 'SMS gönderimine izin yok');
    }

    if (templateId) {
      const template = await query(
        `SELECT id, plain_text_content, body, variables, channel_type, brand_id
         FROM templates
         WHERE id = $1 AND tenant_id = $2 AND COALESCE(is_active, true) = true`,
        [templateId, tenantId]
      );
      if (template.rows.length === 0) return notFound(res);
      const tpl = template.rows[0];
      if (tpl.channel_type && tpl.channel_type !== 'SMS') {
        return badRequest(res, 'Şablon SMS kanalına ait değil');
      }
      if (tpl.brand_id && Number(tpl.brand_id) !== brandId) {
        return badRequest(res, 'Şablon markası uyuşmuyor');
      }
      const rendered = renderTemplateContent({
        subject: '',
        htmlContent: '',
        plainTextContent: tpl.plain_text_content || tpl.body || messageContent || '',
        variables: tpl.variables || [],
        values: templateVariables,
      });
      if (rendered.missingRequired.length > 0) {
        return badRequest(res, 'Eksik şablon değişkenleri var');
      }
      messageContent = rendered.plainTextContent;
    }

    messageContent = sanitizeSmsPlainText(messageContent);
    const lengthCheck = assertSmsLengthAllowed(messageContent);
    if (lengthCheck.ok === false) return badRequest(res, lengthCheck.error);

    const queueEnabled = isMailQueueEnabled();
    if (queueEnabled) {
      const ping = await pingRedis();
      if (!ping.ok) {
        return res.status(503).json({
          success: false,
          error: 'Gönderim kuyruğu şu anda kullanılamıyor',
        });
      }
    } else if (!allowSyncSendFallback()) {
      return res.status(503).json({
        success: false,
        error: 'Gönderim kuyruğu kapalı ve senkron fallback izinli değil',
      });
    }

    const { row, created } = await createOutboundMessage({
      tenantId,
      brandId,
      channelType: 'SMS',
      senderIdentityId: resolved.sender_identity_id,
      templateId: templateId ? Number(templateId) : null,
      recipientData: {
        to: eligibility.normalizedValue,
        phone: eligibility.normalizedValue,
        contact_id: eligibility.contactId || null,
        contact_point_id: contactPointId,
        segment_count: lengthCheck.info.segmentCount,
        encoding: lengthCheck.info.encoding,
        character_count: lengthCheck.info.characterCount,
      },
      subject: null,
      htmlContent: null,
      plainTextContent: messageContent,
      messageContent,
      templateVariables,
      status: 'QUEUED',
      idempotencyKey,
      createdBy: userId,
      conversationId: req.body.conversationId || req.body.conversation_id
        ? Number(req.body.conversationId || req.body.conversation_id)
        : null,
    });

    if (!created) {
      return res.status(200).json({
        success: true,
        queued: row.status === 'QUEUED' || row.status === 'SCHEDULED' || row.status === 'PROCESSING',
        deduplicated: true,
        outboundMessageId: row.id,
        status: row.status,
        message: 'Bu SMS daha önce kuyruğa alınmış',
      });
    }

    if (queueEnabled) {
      await enqueueOutboundSend(row.id, tenantId, 0);
      return res.status(202).json({
        success: true,
        queued: true,
        outboundMessageId: row.id,
        status: 'QUEUED',
        segments: lengthCheck.info,
        message: 'SMS gönderim kuyruğuna alındı',
      });
    }

    const result = await processOutboundSmsMessage(row.id, tenantId);
    if (result.outcome === 'sent') {
      return res.status(200).json({
        success: true,
        queued: false,
        outboundMessageId: row.id,
        status: 'SENT',
        providerMessageId: result.providerMessageId,
        message: 'SMS gönderildi',
      });
    }
    if (result.outcome === 'delayed') {
      return res.status(202).json({
        success: true,
        queued: true,
        outboundMessageId: row.id,
        status: 'SCHEDULED',
        message: 'SMS ertelendi',
      });
    }
    return res.status(400).json({
      success: false,
      outboundMessageId: row.id,
      status: 'FAILED',
      error: result.outcome === 'failed' ? result.message : 'SMS gönderimi başarısız',
    });
  } catch (error: any) {
    const { respondEntitlementError } = await import('../services/entitlementService');
    if (respondEntitlementError(res, error)) return;
    console.error('Error in send-sms:', error?.message || error);
    res.status(500).json({ success: false, error: 'SMS gönderimi tamamlanamadı' });
  }
});

export default router;
