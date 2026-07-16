import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { query } from '../config/database';
import { badRequest, notFound } from '../utils/channelPlatform';
import {
  resolveEligibleSenderIdentity,
  respondSenderResolveError,
} from '../utils/senderIdentityAccess';
import {
  assertNoHeaderInjection,
  MAX_RECIPIENTS_PER_FIELD,
  MAX_RECIPIENTS_TOTAL,
  parseAddressList,
  renderTemplateContent,
  validateEmailAddresses,
} from '../utils/templateRenderer';
import {
  allowSyncSendFallback,
  isMailQueueEnabled,
  pingRedis,
} from '../config/redis';
import { createOutboundMessage } from '../services/outboundMessageService';
import { enqueueOutboundSend } from '../queues/mailQueue';
import { processOutboundEmailMessage } from '../services/outboundSendProcessor';
import { assertEmailNotBlocked } from '../utils/recipientEligibility';
import { requirePermission, forbidden } from '../permissions/requirePermission';
import { hasPermission } from '../permissions/permissionCatalog';

const router = Router();

router.use(authenticate);
router.use(requirePermission('EMAIL_SEND'));

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

    const senderIdentityId = Number(
      req.body.senderIdentityId ?? req.body.sender_identity_id
    );
    const legacyAccountId = Number(req.body.accountId ?? req.body.account_id);

    if (!senderIdentityId && !legacyAccountId) {
      return badRequest(res, 'senderIdentityId zorunludur');
    }

    // Never trust client from/account override for from address
    void req.body.from;

    const toRaw = req.body.to;
    const subjectRaw = req.body.subject ?? '';
    const htmlContent = req.body.htmlContent ?? req.body.html ?? '';
    const plainTextContent = req.body.plainTextContent ?? req.body.text ?? '';
    const replyToRaw = req.body.replyTo ?? req.body.reply_to ?? null;
    const templateId = req.body.templateId ?? req.body.template_id ?? null;
    const templateVariables =
      req.body.templateVariables ?? req.body.template_variables ?? {};
    const draftId = req.body.draftId ?? req.body.draft_id ?? null;
    const allowEmptySubject = Boolean(req.body.allowEmptySubject);
    const idempotencyKey = String(
      req.body.idempotencyKey ?? req.body.idempotency_key ?? ''
    ).trim();

    if (!toRaw) {
      return badRequest(res, 'En az bir alıcı gerekli');
    }

    let toList: string[];
    let ccList: string[];
    let bccList: string[];
    try {
      toList = parseAddressList(toRaw, 'to');
      ccList = parseAddressList(req.body.cc ?? req.body.cc_address, 'cc');
      bccList = parseAddressList(req.body.bcc ?? req.body.bcc_address, 'bcc');
      validateEmailAddresses(toList, 'to');
      validateEmailAddresses(ccList, 'cc');
      validateEmailAddresses(bccList, 'bcc');
    } catch (error: any) {
      if (error.code === 'HEADER_INJECTION' || error.code === 'INVALID_EMAIL') {
        return badRequest(res, 'Alıcı adresleri geçersiz');
      }
      throw error;
    }

    if (toList.length === 0) {
      return badRequest(res, 'En az bir geçerli alıcı gerekli');
    }
    if (
      toList.length > MAX_RECIPIENTS_PER_FIELD ||
      ccList.length > MAX_RECIPIENTS_PER_FIELD ||
      bccList.length > MAX_RECIPIENTS_PER_FIELD
    ) {
      return badRequest(res, 'Alıcı limiti aşıldı');
    }
    if (toList.length + ccList.length + bccList.length > MAX_RECIPIENTS_TOTAL) {
      return badRequest(res, 'Toplam alıcı limiti aşıldı');
    }

    // Early BLOCKED check (brand resolved later for sender path; re-check after brandId)
    const earlyBlock = await assertEmailNotBlocked({
      tenantId,
      addresses: [...toList, ...ccList, ...bccList],
      brandId: null,
    });
    if (!earlyBlock.ok) {
      return badRequest(res, earlyBlock.ok === false ? earlyBlock.reason : 'Gönderim engellenmiş');
    }

    const subject = String(subjectRaw || '');
    try {
      assertNoHeaderInjection(subject, 'subject');
      if (replyToRaw) assertNoHeaderInjection(String(replyToRaw), 'replyTo');
    } catch {
      return badRequest(res, 'Konu veya Reply-To geçersiz karakter içeriyor');
    }

    if (!subject.trim() && !allowEmptySubject) {
      return badRequest(res, 'Konu boş. Onay için allowEmptySubject gerekli');
    }

    if (!htmlContent && !plainTextContent) {
      return badRequest(res, 'İçerik gerekli');
    }

    if (draftId) {
      const draft = await query(
        `SELECT id, status FROM drafts
         WHERE id = $1 AND user_id = $2 AND tenant_id = $3`,
        [draftId, userId, tenantId]
      );
      if (draft.rows.length === 0) return notFound(res);
      if (draft.rows[0].status === 'sent') {
        return res.status(200).json({
          success: true,
          deduplicated: true,
          message: 'Bu taslak zaten gönderilmiş',
        });
      }
    }

    if (!senderIdentityId && legacyAccountId) {
      // Legacy Inbox modal path — sync only, no free-form from
      if (isMailQueueEnabled() && !allowSyncSendFallback()) {
        return badRequest(res, 'Kuyruklu gönderim için senderIdentityId kullanın');
      }

      const { SmtpService } = await import('../services/smtpService');
      const smtpService = new SmtpService();
      const account = await query(
        `SELECT id, name, email FROM mail_accounts
         WHERE id = $1 AND tenant_id = $2 AND is_active = true`,
        [legacyAccountId, tenantId]
      );
      if (account.rows.length === 0) return notFound(res);

      let declaredVariables: unknown[] = [];
      if (templateId) {
        const template = await query(
          `SELECT id, variables FROM templates
           WHERE id = $1 AND tenant_id = $2 AND COALESCE(is_active, true) = true`,
          [templateId, tenantId]
        );
        if (template.rows.length === 0) return notFound(res);
        declaredVariables = template.rows[0].variables || [];
      }

      const rendered = renderTemplateContent({
        subject,
        htmlContent,
        plainTextContent,
        variables: declaredVariables as any,
        values: templateVariables,
      });
      if (rendered.missingRequired.length > 0) {
        return badRequest(res, 'Eksik şablon değişkenleri var');
      }

      const result = await smtpService.sendMail(
        {
          accountId: account.rows[0].id,
          to: toList.join(', '),
          cc: ccList.length ? ccList.join(', ') : undefined,
          bcc: bccList.length ? bccList.join(', ') : undefined,
          subject: rendered.subject,
          text: rendered.plainTextContent || undefined,
          html: rendered.htmlContent || undefined,
          fromName: account.rows[0].name,
          fromEmail: account.rows[0].email,
          replyTo: replyToRaw ? String(replyToRaw) : undefined,
        },
        tenantId
      );

      if (!result.success) {
        return res.status(400).json({ success: false, error: 'E-posta gönderilemedi' });
      }
      return res.status(200).json({
        success: true,
        queued: false,
        messageId: result.messageId,
        message: 'Gönderim tamamlandı',
        legacy: true,
      });
    }

    let brandId: number | null = null;
    let senderId: number | null = null;

    if (senderIdentityId) {
      let resolved;
      try {
        resolved = await resolveEligibleSenderIdentity(senderIdentityId, tenantId);
      } catch (error: any) {
        return respondSenderResolveError(res, error);
      }
      if (!resolved) return notFound(res);
      brandId = resolved.brand_id;
      senderId = resolved.sender_identity_id;
    } else {
      return badRequest(res, 'senderIdentityId zorunludur');
    }

    const brandBlock = await assertEmailNotBlocked({
      tenantId,
      addresses: [...toList, ...ccList, ...bccList],
      brandId,
    });
    if (!brandBlock.ok) {
      return badRequest(res, brandBlock.ok === false ? brandBlock.reason : 'Gönderim engellenmiş');
    }

    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 191) {
      return badRequest(res, 'Geçerli idempotencyKey zorunludur (8-191 karakter)');
    }

    let declaredVariables: unknown[] = [];
    if (templateId) {
      const template = await query(
        `SELECT id, variables, brand_id FROM templates
         WHERE id = $1 AND tenant_id = $2 AND COALESCE(is_active, true) = true`,
        [templateId, tenantId]
      );
      if (template.rows.length === 0) return notFound(res);
      declaredVariables = template.rows[0].variables || [];
    }

    const rendered = renderTemplateContent({
      subject,
      htmlContent,
      plainTextContent,
      variables: declaredVariables as any,
      values: templateVariables,
    });

    if (rendered.missingRequired.length > 0) {
      return badRequest(res, 'Eksik şablon değişkenleri var');
    }

    const queueEnabled = isMailQueueEnabled();
    if (queueEnabled) {
      const ping = await pingRedis();
      if (!ping.ok) {
        return res.status(503).json({
          success: false,
          error: 'Gönderim kuyruğu şu anda kullanılamıyor',
          queue: { enabled: true, redis: false },
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
      channelType: 'EMAIL',
      senderIdentityId: senderId,
      templateId: templateId ? Number(templateId) : null,
      draftId: draftId ? Number(draftId) : null,
      recipientData: {
        to: toList.join(', '),
        cc: ccList.length ? ccList.join(', ') : undefined,
        bcc: bccList.length ? bccList.join(', ') : undefined,
        replyTo: replyToRaw ? String(replyToRaw) : undefined,
      },
      subject: rendered.subject,
      htmlContent: rendered.htmlContent || null,
      plainTextContent: rendered.plainTextContent || null,
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
        message: 'Bu gönderim daha önce kuyruğa alınmış',
      });
    }

    if (queueEnabled) {
      await enqueueOutboundSend(row.id, tenantId, 0);
      return res.status(202).json({
        success: true,
        queued: true,
        outboundMessageId: row.id,
        status: 'QUEUED',
        message: 'Gönderim kuyruğuna alındı',
      });
    }

    // Dev sync fallback — still uses outbound processor (re-validates sender)
    const result = await processOutboundEmailMessage(row.id, tenantId);
    if (result.outcome === 'sent') {
      return res.status(200).json({
        success: true,
        queued: false,
        outboundMessageId: row.id,
        status: 'SENT',
        messageId: result.providerMessageId,
        message: 'Gönderim tamamlandı',
      });
    }

    if (result.outcome === 'delayed') {
      return res.status(202).json({
        success: true,
        queued: true,
        outboundMessageId: row.id,
        status: 'SCHEDULED',
        message: 'Gönderim ertelendi',
      });
    }

    return res.status(400).json({
      success: false,
      outboundMessageId: row.id,
      status: 'FAILED',
      error: result.outcome === 'failed' ? result.message : 'Gönderim başarısız',
    });
  } catch (error: any) {
    const { respondEntitlementError } = await import('../services/entitlementService');
    if (respondEntitlementError(res, error)) return;
    console.error('Error in send-mail endpoint:', error.message || error);
    res.status(500).json({
      success: false,
      error: 'Gönderim tamamlanamadı',
    });
  }
});

export default router;
