import { SmtpService } from './smtpService';
import { SendMailRequest } from '../types';
import { query } from '../config/database';
import { resolveEligibleSenderIdentity } from '../utils/senderIdentityAccess';
import { evaluateSenderDomainPolicy } from '../utils/brandDeliverability';
import {
  assertNoHeaderInjection,
  parseAddressList,
  validateEmailAddresses,
} from '../utils/templateRenderer';
import {
  classifySendError,
  outboundQueueConfig,
  sanitizeOutboundErrorMessage,
} from '../config/outboundQueue';
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
import { assertEmailNotBlocked } from '../utils/recipientEligibility';

const smtpService = new SmtpService();

export type ProcessResult =
  | { outcome: 'sent'; providerMessageId?: string }
  | { outcome: 'delayed'; delayMs: number; code: string; message: string }
  | { outcome: 'failed'; code: string; message: string; retryable: boolean }
  | { outcome: 'skipped'; reason: string };

export async function processOutboundEmailMessage(
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
  await createOutboundAttempt({
    tenantId,
    messageId,
    attemptNumber,
    status: 'PROCESSING',
    provider: 'smtp',
  });

  try {
    if (claimed.channel_type !== 'EMAIL') {
      throw Object.assign(new Error('Bu worker yalnızca EMAIL kanalını işler'), {
        code: 'UNSUPPORTED_CHANNEL',
      });
    }

    if (!claimed.sender_identity_id) {
      throw Object.assign(new Error('Gönderici kimliği eksik'), {
        code: 'MISSING_SENDER',
      });
    }

    const resolved = await resolveEligibleSenderIdentity(
      Number(claimed.sender_identity_id),
      tenantId
    );
    if (!resolved) {
      throw Object.assign(new Error('Gönderici bulunamadı'), { code: 'SENDER_NOT_FOUND' });
    }

    const policy = await evaluateSenderDomainPolicy({
      tenantId,
      brandId: resolved.brand_id,
      senderEmail: resolved.sender_value,
    });
    if (!policy.ok) {
      throw Object.assign(new Error(policy.error || 'Domain uyumsuz'), {
        code: 'DOMAIN_POLICY',
      });
    }

    const recipients = claimed.recipient_data || {};
    const toList = parseAddressList(recipients.to, 'to');
    const ccList = parseAddressList(recipients.cc, 'cc');
    const bccList = parseAddressList(recipients.bcc, 'bcc');
    validateEmailAddresses(toList, 'to');
    validateEmailAddresses(ccList, 'cc');
    validateEmailAddresses(bccList, 'bcc');
    if (toList.length === 0) {
      throw Object.assign(new Error('Alıcı yok'), { code: 'NO_RECIPIENT' });
    }

    const blocked = await assertEmailNotBlocked({
      tenantId,
      addresses: [...toList, ...ccList, ...bccList],
      brandId: claimed.brand_id ? Number(claimed.brand_id) : null,
    });
    if (!blocked.ok) {
      throw Object.assign(
        new Error(blocked.ok === false ? blocked.reason : 'Gönderim engellenmiş'),
        { code: 'RECIPIENT_BLOCKED' }
      );
    }

    if (claimed.campaign_id && claimed.campaign_recipient_id) {
      try {
        const { recordDeliveryLifecycleEvent } = await import('./emailTrackingEventService');
        await recordDeliveryLifecycleEvent({
          tenantId,
          brandId: claimed.brand_id ? Number(claimed.brand_id) : null,
          campaignId: Number(claimed.campaign_id),
          campaignRecipientId: Number(claimed.campaign_recipient_id),
          outboundMessageId: messageId,
          eventType: 'SEND_ATTEMPTED',
          dedupeSuffix: String(attemptNumber),
        });
      } catch {
        /* non-fatal */
      }
    }

    const subject = String(claimed.subject || '');
    assertNoHeaderInjection(subject, 'subject');
    const replyTo = recipients.replyTo ? String(recipients.replyTo) : resolved.reply_to || undefined;
    if (replyTo) assertNoHeaderInjection(replyTo, 'replyTo');

    const primaryRecipient = toList[0];
    const rate = await checkOutboundRateLimits({
      tenantId,
      senderIdentityId: Number(claimed.sender_identity_id),
      primaryRecipient,
    });

    if (!rate.ok) {
      const delayMs = rate.delayMs || outboundQueueConfig.rateLimitDelayMs;
      await createOutboundAttempt({
        tenantId,
        messageId,
        attemptNumber,
        status: 'DELAYED',
        provider: 'smtp',
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
      primaryRecipient,
    });

    const mailRequest: SendMailRequest = {
      accountId: resolved.mail_account_id,
      to: toList.join(', '),
      cc: ccList.length ? ccList.join(', ') : undefined,
      bcc: bccList.length ? bccList.join(', ') : undefined,
      subject,
      text: claimed.plain_text_content || undefined,
      html: claimed.html_content || undefined,
      fromName: resolved.display_name,
      fromEmail: resolved.sender_value,
      replyTo,
    };

    const result = await smtpService.sendMail(mailRequest, tenantId);
    if (!result.success) {
      throw Object.assign(new Error(result.error || 'SMTP gönderimi başarısız'), {
        code: 'SMTP_FAILED',
      });
    }

    await markOutboundSent({
      messageId,
      tenantId,
      providerMessageId: result.messageId || null,
    });

    if (claimed.campaign_id && claimed.campaign_recipient_id) {
      try {
        const { handleCampaignRecipientSmtpAccepted } = await import('./emailBounceService');
        await handleCampaignRecipientSmtpAccepted({
          tenantId,
          brandId: claimed.brand_id ? Number(claimed.brand_id) : null,
          campaignId: Number(claimed.campaign_id),
          campaignRecipientId: Number(claimed.campaign_recipient_id),
          outboundMessageId: messageId,
          contactId: (claimed.recipient_data?.contact_id as number) || null,
          providerMessageId: result.messageId || null,
        });
      } catch {
        /* non-fatal */
      }
    }

    await createOutboundAttempt({
      tenantId,
      messageId,
      attemptNumber,
      status: 'SENT',
      provider: 'smtp',
      completed: true,
    });

    if (claimed.draft_id) {
      await query(
        `UPDATE drafts
         SET status = 'sent', updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND tenant_id = $2`,
        [claimed.draft_id, tenantId]
      );
    }

    return { outcome: 'sent', providerMessageId: result.messageId };
  } catch (error: any) {
    const classified = classifySendError(error);
    const safeMessage = sanitizeOutboundErrorMessage(classified.message);

    await createOutboundAttempt({
      tenantId,
      messageId,
      attemptNumber,
      status: 'FAILED',
      provider: 'smtp',
      errorCode: classified.code,
      safeErrorMessage: safeMessage,
      completed: true,
    });

    const canRetry =
      classified.retryable && attemptNumber < outboundQueueConfig.maxAttempts;

    if (canRetry) {
      const delayMs =
        outboundQueueConfig.backoffBaseMs * Math.pow(2, Math.max(0, attemptNumber - 1));
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

    await markOutboundFailed({
      messageId,
      tenantId,
      errorCode: classified.code,
      errorMessage: safeMessage,
    });

    if (claimed.campaign_id && claimed.campaign_recipient_id) {
      try {
        const { handleCampaignRecipientDeliveryFailure } = await import('./emailBounceService');
        await handleCampaignRecipientDeliveryFailure({
          tenantId,
          campaignId: Number(claimed.campaign_id),
          campaignRecipientId: Number(claimed.campaign_recipient_id),
          outboundMessageId: messageId,
          email: String(claimed.recipient_data?.to || '').split(',')[0]?.trim() || null,
          errorCode: classified.code,
          errorMessage: safeMessage,
          attemptCount: attemptNumber,
        });
      } catch {
        /* non-fatal */
      }
    }

    return {
      outcome: 'failed',
      code: classified.code,
      message: safeMessage,
      retryable: false,
    };
  }
}
