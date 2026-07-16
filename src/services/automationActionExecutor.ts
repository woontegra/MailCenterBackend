import { createHash, randomUUID } from 'crypto';
import { query } from '../config/database';
import { createOutboundMessage } from './outboundMessageService';
import { enqueueOutboundSend } from '../queues/mailQueue';
import { isMailQueueEnabled, allowSyncSendFallback } from '../config/redis';
import { processOutboundEmailMessage } from './outboundSendProcessor';
import { processOutboundSmsMessage } from './outboundSmsProcessor';
import { processOutboundWhatsAppMessage } from './outboundWhatsAppProcessor';
import {
  resolveEligibleSenderIdentity,
  resolveEligibleSmsSenderIdentity,
  resolveEligibleWhatsAppSenderIdentity,
} from '../utils/senderIdentityAccess';
import { checkRecipientEligibility } from '../utils/recipientEligibility';
import { renderTemplateContent } from '../utils/templateRenderer';
import { assertUsageAvailable, channelSendLimitKey } from './entitlementService';
import { AutomationActionType, MAX_DELAY_SECONDS } from './automationConstants';

type ActionResult = {
  status: 'COMPLETED' | 'SKIPPED' | 'FAILED';
  outboundMessageId?: number | null;
  safeError?: string;
  meta?: Record<string, unknown>;
};

function cfg(config: any): Record<string, any> {
  return config && typeof config === 'object' ? config : {};
}

async function loadContactContext(tenantId: number, contactId: number | null | undefined) {
  if (!contactId) return null;
  const result = await query(
    `SELECT id, status, company_name, first_name, last_name
     FROM contacts WHERE id = $1 AND tenant_id = $2`,
    [contactId, tenantId]
  );
  return result.rows[0] || null;
}

async function primaryPoint(
  tenantId: number,
  contactId: number,
  channel: 'EMAIL' | 'SMS' | 'WHATSAPP'
) {
  const result = await query(
    `SELECT id, value, normalized_value
     FROM contact_points
     WHERE tenant_id = $1 AND contact_id = $2 AND channel_type = $3 AND is_active = true
     ORDER BY is_primary DESC, id ASC
     LIMIT 1`,
    [tenantId, contactId, channel]
  );
  return result.rows[0] || null;
}

async function loadTemplate(tenantId: number, templateId: number, channel: string, brandId: number) {
  const result = await query(
    `SELECT * FROM templates
     WHERE id = $1 AND tenant_id = $2 AND COALESCE(is_active, true) = true`,
    [templateId, tenantId]
  );
  const tpl = result.rows[0];
  if (!tpl) throw new Error('Şablon bulunamadı');
  if (tpl.channel_type && String(tpl.channel_type).toUpperCase() !== channel) {
    throw new Error('Şablon kanalı uyuşmuyor');
  }
  if (tpl.brand_id && Number(tpl.brand_id) !== brandId) {
    throw new Error('Şablon markası uyuşmuyor');
  }
  if (channel === 'WHATSAPP') {
    const approval = String(tpl.provider_approval_status || '').toUpperCase();
    if (approval !== 'APPROVED') {
      throw new Error('WhatsApp şablonu APPROVED olmalı');
    }
  }
  return tpl;
}

async function enqueueOrProcess(
  outboundMessageId: number,
  tenantId: number,
  channel: 'EMAIL' | 'SMS' | 'WHATSAPP',
  delayMs: number
) {
  if (isMailQueueEnabled()) {
    await enqueueOutboundSend(outboundMessageId, tenantId, delayMs);
    return;
  }
  if (!allowSyncSendFallback()) {
    throw new Error('Gönderim kuyruğu kapalı');
  }
  if (delayMs > 0) {
    try {
      await enqueueOutboundSend(outboundMessageId, tenantId, delayMs);
    } catch {
      /* leave QUEUED */
    }
    return;
  }
  if (channel === 'SMS') await processOutboundSmsMessage(outboundMessageId, tenantId);
  else if (channel === 'WHATSAPP') await processOutboundWhatsAppMessage(outboundMessageId, tenantId);
  else await processOutboundEmailMessage(outboundMessageId, tenantId);
}

async function executeSend(params: {
  tenantId: number;
  channel: 'EMAIL' | 'SMS' | 'WHATSAPP';
  config: Record<string, any>;
  payload: Record<string, any>;
  executionId: number;
  actionId: number;
  ruleId: number;
  chainDepth: number;
  createdBy: number;
}): Promise<ActionResult> {
  const brandId = Number(params.config.brandId || params.payload.brandId || 0);
  const senderIdentityId = Number(params.config.senderIdentityId || 0);
  const templateId = Number(params.config.templateId || 0);
  const contactId = Number(params.payload.contactId || params.config.contactId || 0) || null;
  const conversationId =
    Number(params.payload.conversationId || params.config.conversationId || 0) || null;
  const delaySeconds = Math.min(
    MAX_DELAY_SECONDS,
    Math.max(0, Number(params.config.delaySeconds || 0) || 0)
  );

  if (!brandId || !senderIdentityId) {
    return { status: 'FAILED', safeError: 'Marka ve gönderici kimliği zorunlu' };
  }
  if (!params.createdBy) {
    return { status: 'FAILED', safeError: 'Otomasyon oluşturan kullanıcı eksik' };
  }

  const brand = await query(`SELECT id FROM brands WHERE id = $1 AND tenant_id = $2`, [
    brandId,
    params.tenantId,
  ]);
  if (!brand.rows[0]) return { status: 'FAILED', safeError: 'Marka bulunamadı' };

  let resolved: any;
  try {
    if (params.channel === 'SMS') {
      resolved = await resolveEligibleSmsSenderIdentity(
        senderIdentityId,
        params.tenantId,
        brandId
      );
    } else if (params.channel === 'WHATSAPP') {
      resolved = await resolveEligibleWhatsAppSenderIdentity(
        senderIdentityId,
        params.tenantId,
        brandId
      );
    } else {
      resolved = await resolveEligibleSenderIdentity(senderIdentityId, params.tenantId);
      if (resolved && Number(resolved.brand_id) !== brandId) {
        return { status: 'FAILED', safeError: 'Gönderici markası uyuşmuyor' };
      }
    }
  } catch (error: any) {
    return { status: 'FAILED', safeError: error?.message || 'Gönderici doğrulanamadı' };
  }
  if (!resolved) return { status: 'FAILED', safeError: 'Gönderici bulunamadı veya pasif' };

  let recipientValue =
    params.config.recipientValue ||
    params.payload.fromAddress ||
    params.payload.toAddress ||
    null;
  let contactPointId: number | null = null;

  if (contactId) {
    const point = await primaryPoint(params.tenantId, contactId, params.channel);
    if (point) {
      recipientValue = point.normalized_value || point.value;
      contactPointId = point.id;
    }
  }

  if (!recipientValue) {
    return { status: 'SKIPPED', safeError: 'Alıcı adresi bulunamadı' };
  }

  const eligibility = await checkRecipientEligibility({
    tenantId: params.tenantId,
    channelType: params.channel,
    value: String(recipientValue),
    brandId,
    strictPreference: params.channel !== 'EMAIL',
  });

  if (!eligibility.eligible) {
    return {
      status: 'SKIPPED',
      safeError: eligibility.reason || 'İletişim izni yok',
      meta: { preferenceStatus: eligibility.preferenceStatus, code: eligibility.code },
    };
  }

  if (params.channel === 'EMAIL' && eligibility.preferenceStatus === 'BLOCKED') {
    return { status: 'SKIPPED', safeError: 'E-posta adresi engellenmiş (BLOCKED)' };
  }

  if (
    (params.channel === 'SMS' || params.channel === 'WHATSAPP') &&
    eligibility.preferenceStatus !== 'OPTED_IN'
  ) {
    return {
      status: 'SKIPPED',
      safeError: `${params.channel} için OPTED_IN zorunlu`,
      meta: { preferenceStatus: eligibility.preferenceStatus },
    };
  }

  await assertUsageAvailable(params.tenantId, channelSendLimitKey(params.channel), 1);

  let subject = params.config.subject || params.payload.subject || '';
  let htmlContent = params.config.htmlContent || '';
  let plainTextContent = params.config.plainTextContent || params.config.messageContent || '';
  let messageContent = params.config.messageContent || '';
  const templateValues = {
    ...(params.config.templateVariables || {}),
    contact_id: contactId,
    company_name: params.payload.companyName,
  };

  if (templateId) {
    const tpl = await loadTemplate(params.tenantId, templateId, params.channel, brandId);
    const rendered = renderTemplateContent({
      subject: tpl.subject || subject,
      htmlContent: tpl.html_content || '',
      plainTextContent: tpl.plain_text_content || tpl.body || messageContent || '',
      variables: tpl.variables || [],
      values: templateValues,
    });
    subject = rendered.subject || subject;
    htmlContent = rendered.htmlContent || htmlContent;
    plainTextContent = rendered.plainTextContent || plainTextContent;
    messageContent = rendered.plainTextContent || messageContent;
  }

  if (params.channel !== 'EMAIL' && !String(messageContent || plainTextContent).trim()) {
    return { status: 'FAILED', safeError: 'Mesaj içeriği boş' };
  }

  const idempotencyKey = createHash('sha256')
    .update(
      `auto:${params.tenantId}:${params.ruleId}:${params.executionId}:${params.actionId}:${params.channel}`
    )
    .digest('hex')
    .slice(0, 64);

  const { row, created } = await createOutboundMessage({
    tenantId: params.tenantId,
    brandId,
    channelType: params.channel,
    senderIdentityId,
    templateId: templateId || null,
    recipientData: {
      to: recipientValue,
      phone: params.channel !== 'EMAIL' ? recipientValue : undefined,
      contact_id: contactId || eligibility.contactId || null,
      contact_point_id: contactPointId,
      _automation: {
        ruleId: params.ruleId,
        executionId: params.executionId,
        actionId: params.actionId,
        chainDepth: params.chainDepth,
      },
    },
    subject: params.channel === 'EMAIL' ? subject : null,
    htmlContent: params.channel === 'EMAIL' ? htmlContent : null,
    plainTextContent: params.channel === 'EMAIL' ? plainTextContent : null,
    messageContent: params.channel !== 'EMAIL' ? messageContent || plainTextContent : null,
    templateVariables: templateValues,
    status: 'QUEUED',
    idempotencyKey,
    createdBy: params.createdBy,
    conversationId,
  });

  if (created || row.status === 'QUEUED' || row.status === 'SCHEDULED') {
    await enqueueOrProcess(row.id, params.tenantId, params.channel, delaySeconds * 1000);
  }

  return {
    status: 'COMPLETED',
    outboundMessageId: row.id,
    meta: { created, idempotencyKey },
  };
}

export async function executeAutomationAction(params: {
  tenantId: number;
  actionType: AutomationActionType;
  config: Record<string, any>;
  payload: Record<string, any>;
  executionId: number;
  actionId: number;
  ruleId: number;
  chainDepth: number;
  createdBy: number;
}): Promise<ActionResult> {
  const c = cfg(params.config);
  const p = params.payload || {};

  try {
    switch (params.actionType) {
      case 'SEND_EMAIL':
        return executeSend({ ...params, channel: 'EMAIL', config: c });
      case 'SEND_SMS':
        return executeSend({ ...params, channel: 'SMS', config: c });
      case 'SEND_WHATSAPP':
        return executeSend({ ...params, channel: 'WHATSAPP', config: c });

      case 'ASSIGN_CONVERSATION': {
        const conversationId = Number(c.conversationId || p.conversationId || 0);
        const assignedUserId = Number(c.assignedUserId || c.value || 0);
        if (!conversationId || !assignedUserId) {
          return { status: 'SKIPPED', safeError: 'Konuşma veya kullanıcı eksik' };
        }
        const user = await query(
          `SELECT id FROM users WHERE id = $1 AND tenant_id = $2 AND COALESCE(is_active,true)=true`,
          [assignedUserId, params.tenantId]
        );
        if (!user.rows[0]) return { status: 'FAILED', safeError: 'Atanacak kullanıcı yok' };
        await query(
          `UPDATE conversations
           SET assigned_user_id = $1, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2 AND tenant_id = $3`,
          [assignedUserId, conversationId, params.tenantId]
        );
        return { status: 'COMPLETED', meta: { conversationId, assignedUserId } };
      }

      case 'SET_CONVERSATION_STATUS': {
        const conversationId = Number(c.conversationId || p.conversationId || 0);
        const status = String(c.status || c.value || '').toUpperCase();
        if (!conversationId || !status) {
          return { status: 'SKIPPED', safeError: 'Durum veya konuşma eksik' };
        }
        await query(
          `UPDATE conversations SET status = $1, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2 AND tenant_id = $3`,
          [status, conversationId, params.tenantId]
        );
        return { status: 'COMPLETED', meta: { conversationId, status } };
      }

      case 'SET_CONVERSATION_PRIORITY': {
        const conversationId = Number(c.conversationId || p.conversationId || 0);
        const priority = String(c.priority || c.value || 'NORMAL').toUpperCase();
        if (!conversationId) return { status: 'SKIPPED', safeError: 'Konuşma eksik' };
        await query(
          `UPDATE conversations SET priority = $1, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2 AND tenant_id = $3`,
          [priority, conversationId, params.tenantId]
        );
        return { status: 'COMPLETED', meta: { conversationId, priority } };
      }

      case 'CREATE_INTERNAL_NOTE': {
        const conversationId = Number(c.conversationId || p.conversationId || 0);
        const note = String(c.note || c.value || '').slice(0, 2000);
        if (!conversationId || !note) {
          return { status: 'SKIPPED', safeError: 'Not veya konuşma eksik' };
        }
        if (!params.createdBy) {
          return { status: 'FAILED', safeError: 'Not için kullanıcı gerekli' };
        }
        await query(
          `INSERT INTO conversation_notes (tenant_id, conversation_id, user_id, content)
           VALUES ($1,$2,$3,$4)`,
          [params.tenantId, conversationId, params.createdBy, note]
        );
        return { status: 'COMPLETED', meta: { conversationId } };
      }

      case 'ADD_CONTACT_BRAND': {
        const contactId = Number(c.contactId || p.contactId || 0);
        const brandId = Number(c.brandId || p.brandId || 0);
        if (!contactId || !brandId) {
          return { status: 'SKIPPED', safeError: 'Kişi veya marka eksik' };
        }
        await query(
          `INSERT INTO contact_brand_links (tenant_id, contact_id, brand_id)
           VALUES ($1,$2,$3)
           ON CONFLICT (tenant_id, contact_id, brand_id) DO NOTHING`,
          [params.tenantId, contactId, brandId]
        );
        return { status: 'COMPLETED', meta: { contactId, brandId } };
      }

      case 'UPDATE_COMMUNICATION_PREFERENCE': {
        const contactId = Number(c.contactId || p.contactId || 0);
        const channelType = String(c.channelType || c.channel || '').toUpperCase();
        const status = String(c.status || 'OPTED_IN').toUpperCase();
        const brandId = c.brandId != null && c.brandId !== '' ? Number(c.brandId) : null;
        if (!contactId || !['EMAIL', 'SMS', 'WHATSAPP'].includes(channelType)) {
          return { status: 'SKIPPED', safeError: 'Tercih alanları eksik' };
        }
        const existing = await query(
          brandId == null
            ? `SELECT id, status FROM communication_preferences
               WHERE tenant_id = $1 AND contact_id = $2 AND channel_type = $3 AND brand_id IS NULL`
            : `SELECT id, status FROM communication_preferences
               WHERE tenant_id = $1 AND contact_id = $2 AND channel_type = $3 AND brand_id = $4`,
          brandId == null
            ? [params.tenantId, contactId, channelType]
            : [params.tenantId, contactId, channelType, brandId]
        );
        const previous = existing.rows[0]?.status || 'UNKNOWN';
        if ((previous === 'OPTED_OUT' || previous === 'BLOCKED') && status === 'OPTED_IN') {
          return {
            status: 'SKIPPED',
            safeError: 'OPTED_OUT/BLOCKED otomasyonla OPTED_IN yapılamaz',
          };
        }
        if (existing.rows[0]) {
          await query(
            `UPDATE communication_preferences
             SET status = $1, source = 'automation', updated_by = $2, updated_at = CURRENT_TIMESTAMP
             WHERE id = $3 AND tenant_id = $4`,
            [status, params.createdBy || null, existing.rows[0].id, params.tenantId]
          );
        } else {
          await query(
            `INSERT INTO communication_preferences
               (tenant_id, contact_id, brand_id, channel_type, status, source, updated_by)
             VALUES ($1,$2,$3,$4,$5,'automation',$6)`,
            [params.tenantId, contactId, brandId, channelType, status, params.createdBy || null]
          );
        }
        return { status: 'COMPLETED', meta: { contactId, channelType, status } };
      }

      default:
        return { status: 'FAILED', safeError: 'Bilinmeyen aksiyon' };
    }
  } catch (error: any) {
    const code = error?.code;
    if (code === 'QUOTA_EXCEEDED' || code === 'FEATURE_NOT_AVAILABLE' || code === 'TENANT_READ_ONLY') {
      return { status: 'SKIPPED', safeError: error.message || code };
    }
    return {
      status: 'FAILED',
      safeError: String(error?.message || 'Aksiyon başarısız').slice(0, 400),
    };
  }
}

export async function enrichPayloadContext(
  tenantId: number,
  payload: Record<string, any>
): Promise<Record<string, any>> {
  const ctx = { ...payload };
  const contactId = Number(ctx.contactId || 0) || null;
  if (contactId) {
    const contact = await loadContactContext(tenantId, contactId);
    if (contact) {
      ctx.contactStatus = contact.status;
      ctx.companyName = contact.company_name;
    }
  }
  const conversationId = Number(ctx.conversationId || 0) || null;
  if (conversationId) {
    const conv = await query(
      `SELECT status, priority, brand_id, channel_type, contact_id
       FROM conversations WHERE id = $1 AND tenant_id = $2`,
      [conversationId, tenantId]
    );
    if (conv.rows[0]) {
      ctx.conversationStatus = conv.rows[0].status;
      ctx.conversationPriority = conv.rows[0].priority;
      ctx.brandId = ctx.brandId || conv.rows[0].brand_id;
      ctx.channel = ctx.channel || conv.rows[0].channel_type;
      ctx.contactId = ctx.contactId || conv.rows[0].contact_id;
    }
  }
  return ctx;
}

export function buildManualEventId(ruleId: number, userId: number) {
  return `manual:${ruleId}:${userId}:${randomUUID()}`.slice(0, 191);
}
