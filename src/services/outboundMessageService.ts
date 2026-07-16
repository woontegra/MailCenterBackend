import { query } from '../config/database';
import { redis } from '../config/redis';
import { outboundQueueConfig } from '../config/outboundQueue';

export type OutboundStatus =
  | 'QUEUED'
  | 'PROCESSING'
  | 'SENT'
  | 'DELIVERED'
  | 'READ'
  | 'FAILED'
  | 'CANCELLED'
  | 'SCHEDULED';

export type CreateOutboundMessageInput = {
  tenantId: number;
  brandId: number | null;
  channelType: 'EMAIL' | 'SMS' | 'WHATSAPP';
  senderIdentityId: number | null;
  templateId?: number | null;
  draftId?: number | null;
  recipientData: Record<string, unknown>;
  subject?: string | null;
  htmlContent?: string | null;
  plainTextContent?: string | null;
  messageContent?: string | null;
  templateVariables?: Record<string, unknown>;
  status?: OutboundStatus;
  priority?: number;
  scheduledAt?: Date | null;
  idempotencyKey: string;
  createdBy: number;
  conversationId?: number | null;
};

export async function findOutboundByIdempotency(tenantId: number, idempotencyKey: string) {
  const result = await query(
    `SELECT * FROM outbound_messages
     WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, idempotencyKey]
  );
  return result.rows[0] || null;
}

export async function createOutboundMessage(input: CreateOutboundMessageInput) {
  const existing = await findOutboundByIdempotency(input.tenantId, input.idempotencyKey);
  if (existing) {
    return { row: existing, created: false };
  }

  const {
    assertUsageAvailable,
    channelSendLimitKey,
    channelSendMetric,
    incrementUsage,
    respondEntitlementError,
    EntitlementError,
  } = await import('./entitlementService');

  try {
    await assertUsageAvailable(
      input.tenantId,
      channelSendLimitKey(input.channelType),
      1
    );
  } catch (err) {
    if (err instanceof EntitlementError) throw err;
    throw err;
  }

  try {
    const result = await query(
      `INSERT INTO outbound_messages (
         tenant_id, brand_id, channel_type, sender_identity_id, template_id, draft_id,
         recipient_data, subject, html_content, plain_text_content, message_content,
         template_variables, status, priority, scheduled_at, idempotency_key, created_by,
         conversation_id, usage_reserved
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,true
       ) RETURNING *`,
      [
        input.tenantId,
        input.brandId,
        input.channelType,
        input.senderIdentityId,
        input.templateId || null,
        input.draftId || null,
        JSON.stringify(input.recipientData || {}),
        input.subject || null,
        input.htmlContent || null,
        input.plainTextContent || null,
        input.messageContent || null,
        JSON.stringify(input.templateVariables || {}),
        input.status || 'QUEUED',
        input.priority || 0,
        input.scheduledAt || null,
        input.idempotencyKey,
        input.createdBy,
        input.conversationId || null,
      ]
    );
    const row = result.rows[0];

    await incrementUsage(input.tenantId, channelSendMetric(input.channelType), 1);

    try {
      const { linkOutboundToConversation } = await import('./conversationService');
      const recipient =
        String(
          (input.recipientData as any)?.to ||
            (input.recipientData as any)?.phone ||
            ''
        ) || '';
      let connectionId: number | null = null;
      if (input.senderIdentityId) {
        const si = await query(
          `SELECT channel_connection_id FROM sender_identities
           WHERE id = $1 AND tenant_id = $2`,
          [input.senderIdentityId, input.tenantId]
        );
        connectionId = si.rows[0]?.channel_connection_id || null;
      }
      if (recipient || input.conversationId) {
        await linkOutboundToConversation({
          tenantId: input.tenantId,
          outboundMessageId: row.id,
          channelType: input.channelType,
          brandId: input.brandId,
          channelConnectionId: connectionId,
          recipientValue: recipient,
          contactId: (input.recipientData as any)?.contact_id
            ? Number((input.recipientData as any).contact_id)
            : null,
          subject: input.subject || null,
          conversationId: input.conversationId || null,
          at: new Date(),
        });
        const refreshed = await query(
          `SELECT * FROM outbound_messages WHERE id = $1 AND tenant_id = $2`,
          [row.id, input.tenantId]
        );
        return { row: refreshed.rows[0] || row, created: true };
      }
    } catch (linkErr) {
      console.error('Error linking outbound to conversation:', linkErr);
    }

    return { row, created: true };
  } catch (error: any) {
    if (error.code === '23505') {
      const again = await findOutboundByIdempotency(input.tenantId, input.idempotencyKey);
      if (again) return { row: again, created: false };
    }
    throw error;
  }
}

/** Atomic claim to prevent double-send across workers */
export async function claimOutboundMessage(messageId: number, tenantId: number) {
  const result = await query(
    `UPDATE outbound_messages
     SET status = 'PROCESSING',
         attempt_count = attempt_count + 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
       AND tenant_id = $2
       AND status IN ('QUEUED', 'SCHEDULED')
     RETURNING *`,
    [messageId, tenantId]
  );
  return result.rows[0] || null;
}

export async function markOutboundSent(params: {
  messageId: number;
  tenantId: number;
  providerMessageId?: string | null;
}) {
  await query(
    `UPDATE outbound_messages
     SET status = 'SENT',
         provider_message_id = COALESCE($3, provider_message_id),
         sent_at = CURRENT_TIMESTAMP,
         last_error_code = NULL,
         last_error_message = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND tenant_id = $2`,
    [params.messageId, params.tenantId, params.providerMessageId || null]
  );

  try {
    const row = await query(
      `SELECT conversation_id, subject FROM outbound_messages
       WHERE id = $1 AND tenant_id = $2`,
      [params.messageId, params.tenantId]
    );
    const conversationId = row.rows[0]?.conversation_id;
    if (conversationId) {
      const { touchConversationOutbound } = await import('./conversationService');
      await touchConversationOutbound({
        conversationId,
        tenantId: params.tenantId,
        at: new Date(),
        subject: row.rows[0]?.subject || null,
      });
    }
  } catch {
    /* non-fatal */
  }
}

/**
 * Advance delivery status by provider_message_id without moving backwards.
 */
export async function advanceOutboundDeliveryStatus(params: {
  tenantId: number;
  providerMessageId: string;
  nextStatus: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
  errorCode?: string | null;
  errorMessage?: string | null;
}) {
  const existing = await query(
    `SELECT id, status FROM outbound_messages
     WHERE tenant_id = $1 AND provider_message_id = $2
     LIMIT 1`,
    [params.tenantId, params.providerMessageId]
  );
  if (existing.rows.length === 0) return null;

  const current = existing.rows[0].status as string;
  const { canAdvanceOutboundStatus } = await import('../whatsapp/whatsappConversationWindow');
  if (!canAdvanceOutboundStatus(current, params.nextStatus)) {
    return existing.rows[0];
  }

  if (params.nextStatus === 'FAILED') {
    await markOutboundFailed({
      messageId: existing.rows[0].id,
      tenantId: params.tenantId,
      errorCode: params.errorCode || 'PROVIDER_FAILED',
      errorMessage: params.errorMessage || 'Provider delivery failed',
    });
  } else {
    await query(
      `UPDATE outbound_messages
       SET status = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND tenant_id = $2`,
      [existing.rows[0].id, params.tenantId, params.nextStatus]
    );
  }

  const refreshed = await query(
    `SELECT * FROM outbound_messages WHERE id = $1 AND tenant_id = $2`,
    [existing.rows[0].id, params.tenantId]
  );
  return refreshed.rows[0] || null;
}

export async function markOutboundFailed(params: {
  messageId: number;
  tenantId: number;
  errorCode: string;
  errorMessage: string;
}) {
  await query(
    `UPDATE outbound_messages
     SET status = 'FAILED',
         failed_at = CURRENT_TIMESTAMP,
         last_error_code = $3,
         last_error_message = $4,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND tenant_id = $2`,
    [
      params.messageId,
      params.tenantId,
      params.errorCode.slice(0, 100),
      params.errorMessage.slice(0, 500),
    ]
  );

  try {
    const row = await query(
      `SELECT id, brand_id, channel_type, conversation_id, recipient_data, last_error_code
       FROM outbound_messages WHERE id = $1 AND tenant_id = $2`,
      [params.messageId, params.tenantId]
    );
    const m = row.rows[0];
    if (m) {
      const rd = typeof m.recipient_data === 'object' ? m.recipient_data : {};
      const origin = rd?._automation || {};
      const { emitAutomationEvent } = await import('./automationEmitter');
      await emitAutomationEvent({
        tenantId: params.tenantId,
        triggerType: 'OUTBOUND_MESSAGE_FAILED',
        triggerEventId: `outbound:${params.messageId}:failed`,
        payload: {
          outboundMessageId: params.messageId,
          brandId: m.brand_id,
          channel: m.channel_type,
          conversationId: m.conversation_id,
          contactId: rd?.contact_id || null,
          outboundErrorCode: params.errorCode,
        },
        chainDepth: Number(origin.chainDepth || 0) + 1,
        originAutomationId: origin.ruleId || null,
      });
    }
  } catch (err) {
    console.error('Automation OUTBOUND_MESSAGE_FAILED emit error:', err);
  }
}

export async function requeueOutboundMessage(params: {
  messageId: number;
  tenantId: number;
  delayMs: number;
  errorCode?: string;
  errorMessage?: string;
}) {
  const scheduledAt = new Date(Date.now() + params.delayMs);
  await query(
    `UPDATE outbound_messages
     SET status = 'SCHEDULED',
         scheduled_at = $3,
         last_error_code = COALESCE($4, last_error_code),
         last_error_message = COALESCE($5, last_error_message),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND tenant_id = $2`,
    [
      params.messageId,
      params.tenantId,
      scheduledAt,
      params.errorCode ? params.errorCode.slice(0, 100) : null,
      params.errorMessage ? params.errorMessage.slice(0, 500) : null,
    ]
  );
  return scheduledAt;
}

export async function createOutboundAttempt(params: {
  tenantId: number;
  messageId: number;
  attemptNumber: number;
  status: 'PROCESSING' | 'SENT' | 'FAILED' | 'DELAYED';
  provider?: string | null;
  errorCode?: string | null;
  safeErrorMessage?: string | null;
  completed?: boolean;
}) {
  const result = await query(
    `INSERT INTO outbound_message_attempts (
       tenant_id, outbound_message_id, attempt_number, status, provider,
       error_code, safe_error_message, completed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (outbound_message_id, attempt_number)
     DO UPDATE SET
       status = EXCLUDED.status,
       provider = COALESCE(EXCLUDED.provider, outbound_message_attempts.provider),
       error_code = EXCLUDED.error_code,
       safe_error_message = EXCLUDED.safe_error_message,
       completed_at = COALESCE(EXCLUDED.completed_at, outbound_message_attempts.completed_at)
     RETURNING *`,
    [
      params.tenantId,
      params.messageId,
      params.attemptNumber,
      params.status,
      params.provider || null,
      params.errorCode || null,
      params.safeErrorMessage || null,
      params.completed ? new Date() : null,
    ]
  );
  return result.rows[0];
}

export async function getOutboundMessageForTenant(id: number, tenantId: number) {
  const result = await query(
    `SELECT om.*,
            b.name AS brand_name,
            si.display_name AS sender_display_name,
            si.sender_value AS sender_value
     FROM outbound_messages om
     LEFT JOIN brands b ON b.id = om.brand_id AND b.tenant_id = om.tenant_id
     LEFT JOIN sender_identities si ON si.id = om.sender_identity_id AND si.tenant_id = om.tenant_id
     WHERE om.id = $1 AND om.tenant_id = $2`,
    [id, tenantId]
  );
  return result.rows[0] || null;
}

export async function listOutboundMessages(tenantId: number, limit = 50) {
  const result = await query(
    `SELECT om.*,
            b.name AS brand_name,
            si.display_name AS sender_display_name,
            si.sender_value AS sender_value
     FROM outbound_messages om
     LEFT JOIN brands b ON b.id = om.brand_id AND b.tenant_id = om.tenant_id
     LEFT JOIN sender_identities si ON si.id = om.sender_identity_id AND si.tenant_id = om.tenant_id
     WHERE om.tenant_id = $1
     ORDER BY om.created_at DESC
     LIMIT $2`,
    [tenantId, Math.min(limit, 100)]
  );
  return result.rows;
}

export async function listOutboundAttempts(messageId: number, tenantId: number) {
  const result = await query(
    `SELECT *
     FROM outbound_message_attempts
     WHERE outbound_message_id = $1 AND tenant_id = $2
     ORDER BY attempt_number ASC`,
    [messageId, tenantId]
  );
  return result.rows;
}

export async function cancelOutboundMessage(id: number, tenantId: number) {
  const result = await query(
    `UPDATE outbound_messages
     SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND tenant_id = $2 AND status IN ('QUEUED', 'SCHEDULED')
     RETURNING *`,
    [id, tenantId]
  );
  const row = result.rows[0] || null;
  if (row && row.usage_reserved) {
    try {
      const { channelSendMetric, decrementCountUsage } = await import('./entitlementService');
      await decrementCountUsage(tenantId, channelSendMetric(row.channel_type), 1);
      await query(
        `UPDATE outbound_messages SET usage_reserved = false WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId]
      );
    } catch {
      /* non-fatal */
    }
  }
  return row;
}

export async function resetFailedForRetry(id: number, tenantId: number) {
  const result = await query(
    `UPDATE outbound_messages
     SET status = 'QUEUED',
         scheduled_at = NULL,
         failed_at = NULL,
         last_error_code = NULL,
         last_error_message = NULL,
         queued_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND tenant_id = $2 AND status = 'FAILED'
     RETURNING *`,
    [id, tenantId]
  );
  return result.rows[0] || null;
}

async function countRecent(key: string, windowSec = 60): Promise<number> {
  const now = Date.now();
  await redis.zremrangebyscore(key, 0, now - windowSec * 1000);
  const card = await redis.zcard(key);
  return Number(card) || 0;
}

async function hitRecent(key: string, windowSec = 60): Promise<void> {
  const now = Date.now();
  await redis.zadd(key, now, `${now}-${Math.random()}`);
  await redis.zremrangebyscore(key, 0, now - windowSec * 1000);
  await redis.expire(key, windowSec + 5);
}

export async function checkOutboundRateLimits(params: {
  tenantId: number;
  senderIdentityId: number | null;
  primaryRecipient: string;
}): Promise<{ ok: boolean; delayMs?: number; reason?: string }> {
  const { tenantPerMinute, senderPerMinute, recipientPerMinute, rateLimitDelayMs } =
    outboundQueueConfig;

  try {
    const tenantCount = await countRecent(`outbound:rl:tenant:${params.tenantId}`);
    if (tenantCount >= tenantPerMinute) {
      return { ok: false, delayMs: rateLimitDelayMs, reason: 'TENANT_RATE_LIMIT' };
    }

    if (params.senderIdentityId) {
      const senderCount = await countRecent(
        `outbound:rl:sender:${params.tenantId}:${params.senderIdentityId}`
      );
      if (senderCount >= senderPerMinute) {
        return { ok: false, delayMs: rateLimitDelayMs, reason: 'SENDER_RATE_LIMIT' };
      }
    }

    const recipientKey = params.primaryRecipient.trim().toLowerCase();
    if (recipientKey) {
      const recipientCount = await countRecent(
        `outbound:rl:recipient:${params.tenantId}:${recipientKey}`
      );
      if (recipientCount >= recipientPerMinute) {
        return { ok: false, delayMs: rateLimitDelayMs, reason: 'RECIPIENT_RATE_LIMIT' };
      }
    }

    return { ok: true };
  } catch {
    return { ok: true };
  }
}

export async function recordOutboundRateHits(params: {
  tenantId: number;
  senderIdentityId: number | null;
  primaryRecipient: string;
}): Promise<void> {
  try {
    await hitRecent(`outbound:rl:tenant:${params.tenantId}`);
    if (params.senderIdentityId) {
      await hitRecent(`outbound:rl:sender:${params.tenantId}:${params.senderIdentityId}`);
    }
    const recipientKey = params.primaryRecipient.trim().toLowerCase();
    if (recipientKey) {
      await hitRecent(`outbound:rl:recipient:${params.tenantId}:${recipientKey}`);
    }
  } catch {
    // ignore
  }
}
