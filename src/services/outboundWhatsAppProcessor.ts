import { query } from '../config/database';
import {
  classifySendError,
  outboundQueueConfig,
  sanitizeOutboundErrorMessage,
} from '../config/outboundQueue';
import { checkRecipientEligibility } from '../utils/recipientEligibility';
import { resolveEligibleWhatsAppSenderIdentity } from '../utils/senderIdentityAccess';
import { renderTemplateContent } from '../utils/templateRenderer';
import {
  unpackWhatsAppCredentials,
  parseWhatsAppSettings,
} from '../whatsapp/whatsappCredentials';
import { getWhatsAppProviderAdapter } from '../whatsapp/whatsappProviderRegistry';
import { e164ToWhatsAppNumber } from '../whatsapp/providers/metaWhatsAppCloudAdapter';
import { hasOpenWhatsAppServiceWindow } from '../whatsapp/whatsappConversationWindow';
import {
  checkOutboundRateLimits,
  claimOutboundMessage,
  createOutboundAttempt,
  getOutboundMessageForTenant,
  markOutboundFailed,
  markOutboundSent,
  recordOutboundRateHits,
  requeueOutboundMessage,
} from './outboundMessageService';
import type { ProcessResult } from './outboundSendProcessor';

function buildTemplateComponents(
  defs: unknown,
  values: Record<string, unknown>
): unknown[] {
  if (!Array.isArray(defs) || defs.length === 0) {
    // Fallback: body parameters from templateVariables in declaration order
    const params = Object.keys(values || {}).map((key) => ({
      type: 'text',
      text: String(values[key] ?? ''),
    }));
    if (params.length === 0) return [];
    return [{ type: 'body', parameters: params }];
  }

  return defs.map((comp: any) => {
    if (!comp || typeof comp !== 'object') return comp;
    const parameters = Array.isArray(comp.parameters)
      ? comp.parameters.map((p: any) => {
          if (p?.variable) {
            return { type: 'text', text: String(values[p.variable] ?? p.text ?? '') };
          }
          if (p?.type === 'text') {
            return { type: 'text', text: String(p.text ?? '') };
          }
          return p;
        })
      : undefined;
    return parameters ? { ...comp, parameters } : comp;
  });
}

export async function processOutboundWhatsAppMessage(
  messageId: number,
  tenantId: number
): Promise<ProcessResult> {
  const claimed = await claimOutboundMessage(messageId, tenantId);
  if (!claimed) {
    const current = await getOutboundMessageForTenant(messageId, tenantId);
    if (!current) return { outcome: 'skipped', reason: 'not_found' };
    if (
      current.status === 'SENT' ||
      current.status === 'DELIVERED' ||
      current.status === 'READ' ||
      current.status === 'CANCELLED'
    ) {
      return { outcome: 'skipped', reason: String(current.status).toLowerCase() };
    }
    if (current.status === 'PROCESSING') {
      return { outcome: 'skipped', reason: 'already_processing' };
    }
    return { outcome: 'skipped', reason: 'not_claimable' };
  }

  const attemptNumber = Number(claimed.attempt_count) || 1;
  const providerName = 'meta_whatsapp_cloud';

  await createOutboundAttempt({
    tenantId,
    messageId,
    attemptNumber,
    status: 'PROCESSING',
    provider: providerName,
  });

  try {
    if (claimed.channel_type !== 'WHATSAPP') {
      throw Object.assign(new Error('Bu worker yalnızca WHATSAPP kanalını işler'), {
        code: 'UNSUPPORTED_CHANNEL',
      });
    }
    if (!claimed.sender_identity_id) {
      throw Object.assign(new Error('Gönderici kimliği eksik'), {
        code: 'MISSING_SENDER',
      });
    }

    const resolved = await resolveEligibleWhatsAppSenderIdentity(
      Number(claimed.sender_identity_id),
      tenantId,
      claimed.brand_id ? Number(claimed.brand_id) : null
    );
    if (!resolved) {
      throw Object.assign(new Error('Gönderici bulunamadı'), { code: 'SENDER_NOT_FOUND' });
    }

    const recipients = claimed.recipient_data || {};
    const toRaw = String(recipients.to || recipients.phone || '').trim();
    if (!toRaw) {
      throw Object.assign(new Error('Alıcı yok'), { code: 'NO_RECIPIENT' });
    }

    const eligibility = await checkRecipientEligibility({
      tenantId,
      channelType: 'WHATSAPP',
      value: toRaw,
      brandId: resolved.brand_id,
      strictPreference: true,
    });
    if (!eligibility.eligible) {
      throw Object.assign(new Error(eligibility.reason || 'WhatsApp gönderimine izin yok'), {
        code: eligibility.code || 'NOT_ELIGIBLE',
      });
    }

    const credentials = unpackWhatsAppCredentials(resolved.encrypted_credentials);
    const config = parseWhatsAppSettings(resolved.settings);
    const adapter = getWhatsAppProviderAdapter(resolved.provider);
    const toProvider = e164ToWhatsAppNumber(eligibility.normalizedValue || toRaw);
    const templateVars = (claimed.template_variables || {}) as Record<string, unknown>;
    const messageMode = String(recipients.message_mode || '').toUpperCase();

    let sendResult;

    if (claimed.template_id || messageMode === 'TEMPLATE') {
      if (!claimed.template_id) {
        throw Object.assign(new Error('Şablon gerekli'), { code: 'TEMPLATE_REQUIRED' });
      }
      const template = await query(
        `SELECT *
         FROM templates
         WHERE id = $1 AND tenant_id = $2 AND COALESCE(is_active, true) = true`,
        [claimed.template_id, tenantId]
      );
      if (template.rows.length === 0) {
        throw Object.assign(new Error('Şablon bulunamadı'), { code: 'TEMPLATE_NOT_FOUND' });
      }
      const tpl = template.rows[0];
      if (tpl.channel_type && tpl.channel_type !== 'WHATSAPP') {
        throw Object.assign(new Error('Şablon WhatsApp kanalına ait değil'), {
          code: 'TEMPLATE_CHANNEL',
        });
      }
      if (String(tpl.provider_approval_status || '').toUpperCase() !== 'APPROVED') {
        throw Object.assign(new Error('Yalnızca APPROVED WhatsApp şablonları gönderilebilir'), {
          code: 'TEMPLATE_NOT_APPROVED',
        });
      }
      if (!tpl.provider_template_name) {
        throw Object.assign(new Error('Provider şablon adı eksik'), {
          code: 'TEMPLATE_NAME_MISSING',
        });
      }

      // Still run renderer for plain preview / variable validation
      const rendered = renderTemplateContent({
        subject: '',
        htmlContent: '',
        plainTextContent: tpl.plain_text_content || tpl.content || tpl.body || '',
        variables: tpl.variables || [],
        values: templateVars,
      });
      if (rendered.missingRequired.length > 0) {
        throw Object.assign(new Error('Eksik şablon değişkenleri'), {
          code: 'TEMPLATE_VARS',
        });
      }

      const components = buildTemplateComponents(
        tpl.provider_template_components,
        templateVars
      );

      sendResult = await adapter.sendTemplateMessage(credentials, {
        toE164: eligibility.normalizedValue || toRaw,
        toProviderNumber: toProvider,
        phoneNumberId: config.phoneNumberId,
        apiVersion: config.apiVersion,
        templateName: String(tpl.provider_template_name),
        languageCode: String(tpl.provider_template_language || 'en_US'),
        components,
      });

      await query(
        `UPDATE outbound_messages
         SET plain_text_content = $3, message_content = $3, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND tenant_id = $2`,
        [messageId, tenantId, rendered.plainTextContent || tpl.provider_template_name]
      );
    } else {
      // Free-form text — only if 24h service window is open (Meta rule)
      const window = await hasOpenWhatsAppServiceWindow({
        tenantId,
        channelConnectionId: resolved.channel_connection_id,
        userPhoneDigits: toProvider,
      });
      if (!window.open) {
        throw Object.assign(
          new Error(
            'Serbest metin yalnızca kullanıcının son 24 saat içinde yazdığı konuşmalarda gönderilebilir. Onaylı şablon kullanın.'
          ),
          { code: 'SERVICE_WINDOW_CLOSED' }
        );
      }

      let messageText = String(
        claimed.message_content || claimed.plain_text_content || ''
      ).trim();
      messageText = messageText.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
      if (!messageText) {
        throw Object.assign(new Error('Mesaj boş olamaz'), { code: 'EMPTY_MESSAGE' });
      }
      if (messageText.length > 4096) {
        throw Object.assign(new Error('Mesaj çok uzun'), { code: 'MESSAGE_TOO_LONG' });
      }

      const rate = await checkOutboundRateLimits({
        tenantId,
        senderIdentityId: Number(claimed.sender_identity_id),
        primaryRecipient: eligibility.normalizedValue || toRaw,
      });
      if (!rate.ok) {
        const delayMs = rate.delayMs || outboundQueueConfig.rateLimitDelayMs;
        await createOutboundAttempt({
          tenantId,
          messageId,
          attemptNumber,
          status: 'DELAYED',
          provider: providerName,
          errorCode: rate.reason || 'RATE_LIMIT',
          safeErrorMessage: 'Gönderim hız sınırı nedeniyle ertelendi',
          completed: true,
        });
        await requeueOutboundMessage({
          messageId,
          tenantId,
          delayMs,
          errorCode: rate.reason || 'RATE_LIMIT',
          errorMessage: 'Gönderim hız sınırı nedeniyle ertelendi',
        });
        return {
          outcome: 'delayed',
          delayMs,
          code: rate.reason || 'RATE_LIMIT',
          message: 'Gönderim hız sınırı nedeniyle ertelendi',
        };
      }

      await recordOutboundRateHits({
        tenantId,
        senderIdentityId: Number(claimed.sender_identity_id),
        primaryRecipient: eligibility.normalizedValue || toRaw,
      });

      sendResult = await adapter.sendTextMessage(credentials, {
        toE164: eligibility.normalizedValue || toRaw,
        toProviderNumber: toProvider,
        body: messageText,
        phoneNumberId: config.phoneNumberId,
        apiVersion: config.apiVersion,
      });
    }

    // Rate limit for template path (text path already recorded)
    if (claimed.template_id || messageMode === 'TEMPLATE') {
      await recordOutboundRateHits({
        tenantId,
        senderIdentityId: Number(claimed.sender_identity_id),
        primaryRecipient: eligibility.normalizedValue || toRaw,
      });
    }

    await markOutboundSent({
      messageId,
      tenantId,
      providerMessageId: sendResult.providerMessageId || null,
    });

    await createOutboundAttempt({
      tenantId,
      messageId,
      attemptNumber,
      status: 'SENT',
      provider: providerName,
      completed: true,
    });

    return { outcome: 'sent', providerMessageId: sendResult.providerMessageId || undefined };
  } catch (error: any) {
    const waClassified =
      error?.graphError || String(error?.code || '').match(/^\d+$/)
        ? getWhatsAppProviderAdapter('META_WHATSAPP_CLOUD').classifyError(error)
        : null;
    const classified = waClassified
      ? {
          code: waClassified.code,
          retryable: waClassified.retryable,
          message: waClassified.safeMessage,
        }
      : classifySendError(error);

    const permanentCodes = new Set([
      'NOT_ELIGIBLE',
      'OPTED_OUT',
      'BLOCKED',
      'UNKNOWN_PREFERENCE',
      'CONTACT_BLOCKED',
      'INVALID_ADDRESS',
      'TEMPLATE_NOT_APPROVED',
      'TEMPLATE_NOT_FOUND',
      'TEMPLATE_CHANNEL',
      'TEMPLATE_VARS',
      'TEMPLATE_REQUIRED',
      'TEMPLATE_NAME_MISSING',
      'SERVICE_WINDOW_CLOSED',
      'EMPTY_MESSAGE',
      'MESSAGE_TOO_LONG',
      'SENDER_NOT_ELIGIBLE',
      'SENDER_NOT_FOUND',
      'MISSING_SENDER',
      'UNSUPPORTED_CHANNEL',
      '190',
      '100',
      '132001',
      '132005',
      '132007',
      '132015',
      '132016',
    ]);

    const retryable =
      classified.retryable &&
      !permanentCodes.has(String(classified.code)) &&
      attemptNumber < outboundQueueConfig.maxAttempts;

    const safeMessage = sanitizeOutboundErrorMessage(classified.message);

    if (retryable) {
      const delayMs = Math.min(
        outboundQueueConfig.backoffBaseMs * Math.pow(2, attemptNumber - 1),
        15 * 60 * 1000
      );
      await createOutboundAttempt({
        tenantId,
        messageId,
        attemptNumber,
        status: 'FAILED',
        provider: providerName,
        errorCode: classified.code,
        safeErrorMessage: safeMessage,
        completed: true,
      });
      await requeueOutboundMessage({
        messageId,
        tenantId,
        delayMs,
        errorCode: classified.code,
        errorMessage: safeMessage,
      });
      return {
        outcome: 'delayed',
        delayMs,
        code: classified.code,
        message: safeMessage,
      };
    }

    await createOutboundAttempt({
      tenantId,
      messageId,
      attemptNumber,
      status: 'FAILED',
      provider: providerName,
      errorCode: classified.code,
      safeErrorMessage: safeMessage,
      completed: true,
    });
    await markOutboundFailed({
      messageId,
      tenantId,
      errorCode: classified.code,
      errorMessage: safeMessage,
    });

    return {
      outcome: 'failed',
      code: classified.code,
      message: safeMessage,
      retryable: false,
    };
  }
}
