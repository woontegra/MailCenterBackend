import { query } from '../config/database';
import { createOutboundMessage } from '../services/outboundMessageService';
import { enqueueOutboundSend } from '../queues/mailQueue';
import { isMailQueueEnabled, pingRedis } from '../config/redis';
import { resolveEligibleSenderIdentity } from '../utils/senderIdentityAccess';

export async function findDefaultEmailSenderForTenant(tenantId: number) {
  const result = await query(
    `SELECT si.id
     FROM sender_identities si
     JOIN channel_connections cc
       ON cc.id = si.channel_connection_id AND cc.tenant_id = si.tenant_id
     WHERE si.tenant_id = $1
       AND si.channel_type = 'EMAIL'
       AND si.is_active = true
       AND si.is_verified = true
       AND cc.status = 'ACTIVE'
     ORDER BY si.is_default DESC NULLS LAST, si.id ASC
     LIMIT 1`,
    [tenantId]
  );
  return result.rows[0]?.id ? Number(result.rows[0].id) : null;
}

/**
 * Queue invite email via tenant EMAIL sender identity + outbound queue.
 * Never fakes success. Returns explicit send status.
 */
export async function queueTeamInviteEmail(params: {
  tenantId: number;
  invitedByUserId: number;
  toEmail: string;
  inviteUrl: string;
  tenantName: string;
  roleLabel: string;
}): Promise<{
  queued: boolean;
  outboundMessageId: number | null;
  status: string;
  message: string;
}> {
  const senderId = await findDefaultEmailSenderForTenant(params.tenantId);
  if (!senderId) {
    return {
      queued: false,
      outboundMessageId: null,
      status: 'NO_SENDER',
      message:
        'Davet kaydedildi ancak aktif ve doğrulanmış e-posta göndericisi olmadığı için mail gönderilemedi',
    };
  }

  let resolved;
  try {
    resolved = await resolveEligibleSenderIdentity(senderId, params.tenantId);
  } catch {
    return {
      queued: false,
      outboundMessageId: null,
      status: 'SENDER_INELIGIBLE',
      message:
        'Davet kaydedildi ancak e-posta göndericisi gönderim için uygun değil; mail gönderilemedi',
    };
  }
  if (!resolved) {
    return {
      queued: false,
      outboundMessageId: null,
      status: 'NO_SENDER',
      message:
        'Davet kaydedildi ancak aktif ve doğrulanmış e-posta göndericisi olmadığı için mail gönderilemedi',
    };
  }

  if (!isMailQueueEnabled()) {
    return {
      queued: false,
      outboundMessageId: null,
      status: 'QUEUE_DISABLED',
      message: 'Davet kaydedildi ancak gönderim kuyruğu kapalı; mail gönderilemedi',
    };
  }

  const ping = await pingRedis();
  if (!ping.ok) {
    return {
      queued: false,
      outboundMessageId: null,
      status: 'QUEUE_UNAVAILABLE',
      message: 'Davet kaydedildi ancak gönderim kuyruğu kullanılamıyor; mail gönderilemedi',
    };
  }

  const subject = `${params.tenantName} ekibine davet`;
  const plain = [
    `Merhaba,`,
    ``,
    `${params.tenantName} ekibine ${params.roleLabel} rolüyle davet edildiniz.`,
    `Daveti kabul etmek için bağlantı:`,
    params.inviteUrl,
    ``,
    `Bu bağlantı sınırlı süre geçerlidir.`,
  ].join('\n');
  const html = `<p>Merhaba,</p><p><strong>${escapeHtml(
    params.tenantName
  )}</strong> ekibine <strong>${escapeHtml(
    params.roleLabel
  )}</strong> rolüyle davet edildiniz.</p><p><a href="${escapeHtml(
    params.inviteUrl
  )}">Daveti kabul et</a></p><p>Bu bağlantı sınırlı süre geçerlidir.</p>`;

  const idempotencyKey = `team_invite_${params.tenantId}_${params.toEmail.toLowerCase()}_${Date.now()}`;
  const { row } = await createOutboundMessage({
    tenantId: params.tenantId,
    brandId: resolved.brand_id,
    channelType: 'EMAIL',
    senderIdentityId: resolved.sender_identity_id,
    recipientData: { to: params.toEmail },
    subject,
    htmlContent: html,
    plainTextContent: plain,
    status: 'QUEUED',
    idempotencyKey,
    createdBy: params.invitedByUserId,
  });

  await enqueueOutboundSend(row.id, params.tenantId);

  return {
    queued: true,
    outboundMessageId: row.id,
    status: 'QUEUED',
    message: 'Davet e-postası kuyruğa alındı',
  };
}

function escapeHtml(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
