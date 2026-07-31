import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { query } from '../config/database';
import { badRequest, notFound } from '../utils/channelPlatform';
import {
  resolveEligibleWhatsAppSenderIdentity,
  respondSenderResolveError,
} from '../utils/senderIdentityAccess';
import { checkRecipientEligibility } from '../utils/recipientEligibility';
import { getTenantDefaultCountryCode } from '../utils/contactNormalize';
import {
  allowSyncSendFallback,
  isMailQueueEnabled,
  pingRedis,
} from '../config/redis';
import { createOutboundMessage } from '../services/outboundMessageService';
import { enqueueOutboundSend } from '../queues/mailQueue';
import { processOutboundWhatsAppMessage } from '../services/outboundWhatsAppProcessor';
import { hasOpenWhatsAppServiceWindow } from '../whatsapp/whatsappConversationWindow';
import { renderTemplateContent } from '../utils/templateRenderer';
import { requirePermission, forbidden } from '../permissions/requirePermission';
import { hasPermission } from '../permissions/permissionCatalog';

const router = Router();
router.use(authenticate);
router.use(requirePermission('WHATSAPP_SEND'));

async function resolveRecipientPhone(params: {
  tenantId: number;
  recipient?: string | null;
  contactPointId?: number | null;
}): Promise<{ ok: true; phone: string } | { ok: false; status: number; error: string }> {
  if (params.contactPointId) {
    const point = await query(
      `SELECT cp.value, cp.normalized_value, cp.channel_type
       FROM contact_points cp
       WHERE cp.id = $1 AND cp.tenant_id = $2 AND cp.is_active = true`,
      [params.contactPointId, params.tenantId]
    );
    if (point.rows.length === 0) return { ok: false, status: 404, error: 'Not found' };
    const row = point.rows[0];
    if (row.channel_type !== 'WHATSAPP' && row.channel_type !== 'SMS') {
      return { ok: false, status: 400, error: 'İletişim noktası WhatsApp için uygun değil' };
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

    void req.body.accessToken;
    void req.body.access_token;
    void req.body.phoneNumberId;
    void req.body.phone_number_id;

    const brandId = Number(req.body.brandId ?? req.body.brand_id);
    const senderIdentityId = Number(
      req.body.senderIdentityId ?? req.body.sender_identity_id
    );
    const channelConnectionIdRaw =
      req.body.channelConnectionId ?? req.body.channel_connection_id;
    const channelConnectionId = channelConnectionIdRaw
      ? Number(channelConnectionIdRaw)
      : null;
    const templateId = req.body.templateId ?? req.body.template_id ?? null;
    const contactPointIdRaw = req.body.contactPointId ?? req.body.contact_point_id;
    const contactPointId = contactPointIdRaw ? Number(contactPointIdRaw) : null;
    const recipient = req.body.recipient ?? req.body.to ?? null;
    const templateVariables =
      req.body.templateVariables ?? req.body.template_variables ?? {};
    const idempotencyKey = String(
      req.body.idempotencyKey ?? req.body.idempotency_key ?? ''
    ).trim();
    const messageMode = String(
      req.body.messageMode ?? req.body.message_mode ?? (templateId ? 'TEMPLATE' : 'TEXT')
    ).toUpperCase();
    let messageContent = String(req.body.messageContent ?? req.body.message ?? '').trim();

    if (!brandId || !senderIdentityId) {
      return badRequest(res, 'brandId ve senderIdentityId zorunludur');
    }
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 191) {
      return badRequest(res, 'Geçerli idempotencyKey zorunludur (8-191 karakter)');
    }

    const brand = await query(`SELECT id FROM brands WHERE id = $1 AND tenant_id = $2`, [
      brandId,
      tenantId,
    ]);
    if (brand.rows.length === 0) return notFound(res);

    let resolved;
    try {
      resolved = await resolveEligibleWhatsAppSenderIdentity(
        senderIdentityId,
        tenantId,
        brandId
      );
    } catch (error: any) {
      return respondSenderResolveError(res, error);
    }
    if (!resolved) return notFound(res);

    if (
      channelConnectionId &&
      Number(resolved.channel_connection_id) !== Number(channelConnectionId)
    ) {
      return badRequest(res, 'senderIdentityId ile channelConnectionId uyuşmuyor');
    }

    const connectionWabaId = String(
      (resolved.settings as any)?.waba_id || ''
    ).trim();

    const phoneResolved = await resolveRecipientPhone({
      tenantId,
      recipient,
      contactPointId,
    });
    if (phoneResolved.ok === false) {
      if (phoneResolved.status === 404) return notFound(res);
      return badRequest(res, phoneResolved.error);
    }

    const eligibility = await checkRecipientEligibility({
      tenantId,
      channelType: 'WHATSAPP',
      value: phoneResolved.phone,
      brandId,
      countryCode: req.body.country_code || (await getTenantDefaultCountryCode(tenantId)),
      strictPreference: true,
    });
    if (!eligibility.eligible) {
      return badRequest(res, eligibility.reason || 'WhatsApp gönderimine izin yok');
    }

    if (messageMode === 'TEMPLATE' || templateId) {
      if (!templateId) return badRequest(res, 'templateId gerekli');
      const template = await query(
        `SELECT * FROM templates
         WHERE id = $1 AND tenant_id = $2 AND COALESCE(is_active, true) = true`,
        [templateId, tenantId]
      );
      if (template.rows.length === 0) return notFound(res);
      const tpl = template.rows[0];
      if (tpl.channel_type && tpl.channel_type !== 'WHATSAPP') {
        return badRequest(res, 'Şablon WhatsApp kanalına ait değil');
      }
      if (tpl.brand_id && Number(tpl.brand_id) !== brandId) {
        return badRequest(res, 'Şablon markası uyuşmuyor');
      }
      if (String(tpl.provider_approval_status || '').toUpperCase() !== 'APPROVED') {
        return badRequest(res, 'Yalnızca APPROVED WhatsApp şablonları gönderilebilir');
      }
      if (!tpl.provider_template_name) {
        return badRequest(res, 'Provider şablon adı eksik');
      }
      const tplWaba = String(tpl.provider_waba_id || '').trim();
      if (connectionWabaId && tplWaba && tplWaba !== connectionWabaId) {
        return badRequest(
          res,
          `Şablon başka WABA'ya ait (şablon=${tplWaba}, gönderici=${connectionWabaId})`
        );
      }
      const rendered = renderTemplateContent({
        subject: '',
        htmlContent: '',
        plainTextContent: tpl.plain_text_content || tpl.content || '',
        variables: tpl.variables || [],
        values: templateVariables,
      });
      if (rendered.missingRequired.length > 0) {
        return badRequest(res, 'Eksik şablon değişkenleri var');
      }
      messageContent = rendered.plainTextContent || tpl.provider_template_name;
    } else {
      const window = await hasOpenWhatsAppServiceWindow({
        tenantId,
        channelConnectionId: resolved.channel_connection_id,
        userPhoneDigits: eligibility.normalizedValue || phoneResolved.phone,
      });
      if (!window.open) {
        return badRequest(
          res,
          'Serbest metin yalnızca kullanıcının son 24 saat içinde yazdığı konuşmalarda gönderilebilir. Onaylı şablon kullanın.'
        );
      }
      if (!messageContent) return badRequest(res, 'Mesaj içeriği gerekli');
      if (messageContent.length > 4096) return badRequest(res, 'Mesaj çok uzun');
    }

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
      channelType: 'WHATSAPP',
      senderIdentityId: resolved.sender_identity_id,
      templateId: templateId ? Number(templateId) : null,
      recipientData: {
        to: eligibility.normalizedValue,
        phone: eligibility.normalizedValue,
        contact_id: eligibility.contactId || null,
        contact_point_id: contactPointId,
        message_mode: templateId ? 'TEMPLATE' : 'TEXT',
      },
      subject: null,
      htmlContent: null,
      plainTextContent: messageContent || null,
      messageContent: messageContent || null,
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
        queued:
          row.status === 'QUEUED' ||
          row.status === 'SCHEDULED' ||
          row.status === 'PROCESSING',
        deduplicated: true,
        outboundMessageId: row.id,
        status: row.status,
        message: 'Bu WhatsApp mesajı daha önce kuyruğa alınmış',
      });
    }

    if (queueEnabled) {
      await enqueueOutboundSend(row.id, tenantId, 0);
      return res.status(202).json({
        success: true,
        queued: true,
        outboundMessageId: row.id,
        status: 'QUEUED',
        message: 'WhatsApp mesajı kuyruğa alındı',
      });
    }

    const result = await processOutboundWhatsAppMessage(row.id, tenantId);
    if (result.outcome === 'sent') {
      return res.status(200).json({
        success: true,
        queued: false,
        outboundMessageId: row.id,
        status: 'SENT',
        providerMessageId: result.providerMessageId,
        message: 'WhatsApp mesajı gönderildi',
      });
    }
    if (result.outcome === 'delayed') {
      return res.status(202).json({
        success: true,
        queued: true,
        outboundMessageId: row.id,
        status: 'SCHEDULED',
        message: 'WhatsApp mesajı ertelendi',
      });
    }
    return res.status(400).json({
      success: false,
      outboundMessageId: row.id,
      status: 'FAILED',
      error: result.outcome === 'failed' ? result.message : 'WhatsApp gönderimi başarısız',
    });
  } catch (error: any) {
    const { respondEntitlementError } = await import('../services/entitlementService');
    if (respondEntitlementError(res, error)) return;
    console.error('Error in send-whatsapp:', error?.message || error);
    res.status(500).json({ success: false, error: 'WhatsApp gönderimi tamamlanamadı' });
  }
});

export default router;
