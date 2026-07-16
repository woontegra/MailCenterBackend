import { query } from '../config/database';
import {
  classifySendError,
  outboundQueueConfig,
  sanitizeOutboundErrorMessage,
} from '../config/outboundQueue';
import { checkRecipientEligibility } from '../utils/recipientEligibility';
import { resolveEligibleSmsSenderIdentity } from '../utils/senderIdentityAccess';
import { renderTemplateContent } from '../utils/templateRenderer';
import { unpackSmsCredentials } from '../sms/smsCredentials';
import { getSmsProviderAdapter } from '../sms/smsProviderRegistry';
import { e164ToNetgsmNumber } from '../sms/providers/netgsmAdapter';
import { sanitizeSmsPlainText } from '../sms/smsContent';
import { assertSmsLengthAllowed, analyzeSmsContent } from '../sms/smsSegmentCounter';
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

export async function processOutboundSmsMessage(
  messageId: number,
  tenantId: number
): Promise<ProcessResult> {
  const claimed = await claimOutboundMessage(messageId, tenantId);
  if (!claimed) {
    const current = await getOutboundMessageForTenant(messageId, tenantId);
    if (!current) return { outcome: 'skipped', reason: 'not_found' };
    if (current.status === 'SENT' || current.status === 'CANCELLED') {
      return { outcome: 'skipped', reason: current.status.toLowerCase() };
    }
    if (current.status === 'PROCESSING') {
      return { outcome: 'skipped', reason: 'already_processing' };
    }
    return { outcome: 'skipped', reason: 'not_claimable' };
  }

  const attemptNumber = Number(claimed.attempt_count) || 1;
  const providerName = 'netgsm';

  await createOutboundAttempt({
    tenantId,
    messageId,
    attemptNumber,
    status: 'PROCESSING',
    provider: providerName,
  });

  try {
    if (claimed.channel_type !== 'SMS') {
      throw Object.assign(new Error('Bu worker yalnızca SMS kanalını işler'), {
        code: 'UNSUPPORTED_CHANNEL',
      });
    }
    if (!claimed.sender_identity_id) {
      throw Object.assign(new Error('Gönderici kimliği eksik'), {
        code: 'MISSING_SENDER',
      });
    }

    const resolved = await resolveEligibleSmsSenderIdentity(
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
      channelType: 'SMS',
      value: toRaw,
      brandId: resolved.brand_id,
      strictPreference: true,
    });
    if (!eligibility.eligible) {
      throw Object.assign(new Error(eligibility.reason || 'SMS gönderimine izin yok'), {
        code: eligibility.code || 'NOT_ELIGIBLE',
      });
    }

    let messageText = sanitizeSmsPlainText(
      claimed.message_content || claimed.plain_text_content || ''
    );

    if (claimed.template_id) {
      const template = await query(
        `SELECT id, plain_text_content, body, variables, channel_type
         FROM templates
         WHERE id = $1 AND tenant_id = $2 AND COALESCE(is_active, true) = true`,
        [claimed.template_id, tenantId]
      );
      if (template.rows.length === 0) {
        throw Object.assign(new Error('Şablon bulunamadı'), { code: 'TEMPLATE_NOT_FOUND' });
      }
      const tpl = template.rows[0];
      if (tpl.channel_type && tpl.channel_type !== 'SMS') {
        throw Object.assign(new Error('Şablon SMS kanalına ait değil'), {
          code: 'TEMPLATE_CHANNEL',
        });
      }
      const rendered = renderTemplateContent({
        subject: '',
        htmlContent: '',
        plainTextContent: tpl.plain_text_content || tpl.body || '',
        variables: tpl.variables || [],
        values: claimed.template_variables || {},
      });
      if (rendered.missingRequired.length > 0) {
        throw Object.assign(new Error('Eksik şablon değişkenleri'), {
          code: 'TEMPLATE_VARS',
        });
      }
      messageText = sanitizeSmsPlainText(rendered.plainTextContent);
    }

    const lengthCheck = assertSmsLengthAllowed(messageText);
    if (lengthCheck.ok === false) {
      throw Object.assign(new Error(lengthCheck.error), { code: 'MESSAGE_TEXT_ERROR' });
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

    const credentials = unpackSmsCredentials(resolved.encrypted_credentials);
    const adapter = getSmsProviderAdapter(resolved.provider);
    const settings = resolved.settings || {};
    const encoding =
      settings.encoding === 'ASCII' || settings.encoding === 'TR'
        ? settings.encoding
        : lengthCheck.info.encoding === 'Unicode'
          ? 'TR'
          : null;

    // Validate credentials / authorized header without sending SMS when possible
    if (adapter.supportsSenderIdentity()) {
      const test = await adapter.testConnection(credentials);
      if (!test.ok && (test.code === '30' || test.code === 'INVALID_AUTH')) {
        throw Object.assign(new Error(test.safeMessage), { code: test.code || '30' });
      }
      if (test.ok && test.headers && test.headers.length > 0) {
        const headerOk = test.headers.some(
          (h) => h.toLowerCase() === resolved.sender_value.toLowerCase()
        );
        if (!headerOk) {
          throw Object.assign(new Error('Gönderici başlığı hesapta yetkili değil'), {
            code: '40',
          });
        }
      }
    }

    const sendResult = await adapter.sendMessage(credentials, {
      toE164: eligibility.normalizedValue || toRaw,
      toProviderNumber: e164ToNetgsmNumber(eligibility.normalizedValue || toRaw),
      message: messageText,
      senderHeader: resolved.sender_value,
      encoding: encoding as any,
      iysfilter: settings.iysfilter != null ? String(settings.iysfilter) : '0',
    });

    const segments = analyzeSmsContent(messageText);

    await markOutboundSent({
      messageId,
      tenantId,
      providerMessageId: sendResult.providerMessageId || null,
    });

    // Persist segment metadata without schema change
    await query(
      `UPDATE outbound_messages
       SET recipient_data = COALESCE(recipient_data, '{}'::jsonb) || $3::jsonb,
           plain_text_content = $4,
           message_content = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND tenant_id = $2`,
      [
        messageId,
        tenantId,
        JSON.stringify({
          segment_count: segments.segmentCount,
          encoding: segments.encoding,
          character_count: segments.characterCount,
        }),
        messageText,
      ]
    );

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
    const smsClassified =
      error?.code && String(error.code).match(/^\d+$/)
        ? getSmsProviderAdapter('NETGSM').classifyError(error)
        : null;
    const classified = smsClassified
      ? {
          code: smsClassified.code,
          retryable: smsClassified.retryable,
          message: smsClassified.safeMessage,
          safeMessage: smsClassified.safeMessage,
        }
      : classifySendError(error);
    const permanentCodes = new Set([
      'NOT_ELIGIBLE',
      'OPTED_OUT',
      'BLOCKED',
      'UNKNOWN_PREFERENCE',
      'CONTACT_BLOCKED',
      'INVALID_ADDRESS',
      'MESSAGE_TEXT_ERROR',
      'TEMPLATE_VARS',
      'TEMPLATE_NOT_FOUND',
      'TEMPLATE_CHANNEL',
      'SENDER_NOT_ELIGIBLE',
      'SENDER_NOT_FOUND',
      'MISSING_SENDER',
      'UNSUPPORTED_CHANNEL',
      '40',
      '30',
      '20',
      '50',
      '51',
      '70',
    ]);

    const retryable =
      classified.retryable &&
      !permanentCodes.has(String(classified.code)) &&
      attemptNumber < outboundQueueConfig.maxAttempts;

    const safeMessage = sanitizeOutboundErrorMessage(
      (classified as any).safeMessage || classified.message
    );

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
