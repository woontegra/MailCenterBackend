import { query } from '../config/database';
import { normalizeEmail, normalizePhone, getTenantDefaultCountryCode } from '../utils/contactNormalize';

export type ConversationChannel = 'EMAIL' | 'SMS' | 'WHATSAPP';
export type ConversationStatus = 'OPEN' | 'WAITING_REPLY' | 'RESOLVED' | 'ARCHIVED';
export type ConversationPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

const STATUS_SET = new Set(['OPEN', 'WAITING_REPLY', 'RESOLVED', 'ARCHIVED']);
const PRIORITY_SET = new Set(['LOW', 'NORMAL', 'HIGH', 'URGENT']);

export function isConversationStatus(v: unknown): v is ConversationStatus {
  return STATUS_SET.has(String(v || '').toUpperCase());
}

export function isConversationPriority(v: unknown): v is ConversationPriority {
  return PRIORITY_SET.has(String(v || '').toUpperCase());
}

export function sanitizeNoteContent(raw: string): string {
  return String(raw || '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, 5000);
}

export function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) return null;
  let s = String(value).trim();
  if (!s) return null;
  if (!s.startsWith('<')) s = `<${s}`;
  if (!s.endsWith('>')) s = `${s}>`;
  return s.toLowerCase();
}

export function parseReferencesHeader(value: string | null | undefined): string[] {
  if (!value) return [];
  const matches = String(value).match(/<[^>]+>/g) || [];
  return matches.map((m) => normalizeMessageId(m)!).filter(Boolean);
}

/**
 * Safe contact label for conversation rows.
 * contacts has first_name/last_name/company_name — not display_name.
 * Aliases as contact_display_name for the existing API contract.
 */
export const CONTACT_DISPLAY_NAME_SQL = `COALESCE(
  NULLIF(BTRIM(CONCAT_WS(
    ' ',
    NULLIF(BTRIM(ct.first_name), ''),
    NULLIF(BTRIM(ct.last_name), '')
  )), ''),
  NULLIF(BTRIM(ct.company_name), ''),
  NULLIF(BTRIM(c.participant_value), '')
)`;

export async function getOwnedConversation(id: number, tenantId: number) {
  const result = await query(
    `SELECT c.*,
            b.name AS brand_name,
            b.accent_color AS brand_accent_color,
            ${CONTACT_DISPLAY_NAME_SQL} AS contact_display_name,
            u.name AS assigned_user_name,
            u.email AS assigned_user_email
     FROM conversations c
     LEFT JOIN brands b ON b.id = c.brand_id AND b.tenant_id = c.tenant_id
     LEFT JOIN contacts ct ON ct.id = c.contact_id AND ct.tenant_id = c.tenant_id
     LEFT JOIN users u ON u.id = c.assigned_user_id AND u.tenant_id = c.tenant_id
     WHERE c.id = $1 AND c.tenant_id = $2`,
    [id, tenantId]
  );
  return result.rows[0] || null;
}

export async function resolveContactIdByParticipant(params: {
  tenantId: number;
  channelType: ConversationChannel;
  normalizedValue: string;
}): Promise<number | null> {
  const channelFilter =
    params.channelType === 'EMAIL'
      ? `channel_type = 'EMAIL'`
      : `channel_type IN ('SMS', 'WHATSAPP')`;
  const digits = params.normalizedValue.replace(/\D/g, '');
  const result = await query(
    `SELECT contact_id FROM contact_points
     WHERE tenant_id = $1
       AND ${channelFilter}
       AND is_active = true
       AND (
         normalized_value = $2
         OR ($3 <> '' AND regexp_replace(normalized_value, '\\D', '', 'g') = $3)
       )
     LIMIT 1`,
    [params.tenantId, params.normalizedValue, digits]
  );
  return result.rows[0]?.contact_id || null;
}

export async function normalizeParticipant(params: {
  tenantId: number;
  channelType: ConversationChannel;
  value: string;
}): Promise<{ participantValue: string; normalized: string } | null> {
  const raw = String(params.value || '').trim();
  if (!raw) return null;

  if (params.channelType === 'EMAIL') {
    const emailMatch = raw.match(/[\w.+-]+@[\w.-]+\.\w+/);
    const candidate = emailMatch ? emailMatch[0] : raw;
    const email = normalizeEmail(candidate);
    if (!email.ok) return null;
    return { participantValue: email.value, normalized: email.normalized };
  }

  const phone = normalizePhone({ value: raw, countryCode: null });
  if (phone.ok) {
    return { participantValue: phone.value, normalized: phone.normalized };
  }
  const cc = await getTenantDefaultCountryCode(params.tenantId);
  const again = normalizePhone({ value: raw, countryCode: cc });
  if (!again.ok) {
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 8) {
      return { participantValue: raw, normalized: `+${digits}` };
    }
    return null;
  }
  return { participantValue: again.value, normalized: again.normalized };
}

async function resolveBrandForMailAccount(
  tenantId: number,
  accountId: number
): Promise<{ brandId: number | null; connectionId: number | null }> {
  const result = await query(
    `SELECT cc.brand_id, cc.id AS channel_connection_id
     FROM channel_connections cc
     WHERE cc.tenant_id = $1
       AND cc.channel_type = 'EMAIL'
       AND cc.mail_account_id = $2
     ORDER BY CASE WHEN cc.status = 'ACTIVE' THEN 0 ELSE 1 END, cc.id
     LIMIT 1`,
    [tenantId, accountId]
  );
  if (result.rows[0]) {
    return {
      brandId: result.rows[0].brand_id || null,
      connectionId: result.rows[0].channel_connection_id || null,
    };
  }
  return { brandId: null, connectionId: null };
}

/**
 * Find email conversation by Message-ID / In-Reply-To / References.
 * Does NOT merge solely by subject.
 */
export async function findEmailConversationByHeaders(params: {
  tenantId: number;
  inReplyTo?: string | null;
  references?: string[] | null;
}): Promise<number | null> {
  const ids = new Set<string>();
  const irt = normalizeMessageId(params.inReplyTo);
  if (irt) ids.add(irt);
  for (const r of params.references || []) {
    const n = normalizeMessageId(r);
    if (n) ids.add(n);
  }
  if (ids.size === 0) return null;

  const list = Array.from(ids);
  const result = await query(
    `SELECT conversation_id
     FROM mails
     WHERE tenant_id = $1
       AND conversation_id IS NOT NULL
       AND (
         LOWER(message_id) = ANY($2::text[])
         OR LOWER(COALESCE(in_reply_to, '')) = ANY($2::text[])
       )
     ORDER BY date DESC NULLS LAST
     LIMIT 1`,
    [params.tenantId, list]
  );
  return result.rows[0]?.conversation_id || null;
}

export async function findChannelConversation(params: {
  tenantId: number;
  channelType: 'SMS' | 'WHATSAPP';
  channelConnectionId: number | null;
  normalizedParticipant: string;
}): Promise<any | null> {
  const result = await query(
    `SELECT * FROM conversations
     WHERE tenant_id = $1
       AND channel_type = $2
       AND normalized_participant_value = $3
       AND (
         ($4::int IS NULL AND channel_connection_id IS NULL)
         OR channel_connection_id = $4
       )
       AND status <> 'ARCHIVED'
     ORDER BY last_message_at DESC NULLS LAST, id DESC
     LIMIT 1`,
    [
      params.tenantId,
      params.channelType,
      params.normalizedParticipant,
      params.channelConnectionId,
    ]
  );
  return result.rows[0] || null;
}

export async function createConversation(params: {
  tenantId: number;
  brandId?: number | null;
  channelType: ConversationChannel;
  channelConnectionId?: number | null;
  contactId?: number | null;
  subject?: string | null;
  participantValue: string;
  normalizedParticipantValue: string;
  status?: ConversationStatus;
  priority?: ConversationPriority;
  lastMessageAt?: Date | null;
  lastInboundAt?: Date | null;
  lastOutboundAt?: Date | null;
  unreadCount?: number;
}): Promise<any> {
  const result = await query(
    `INSERT INTO conversations (
       tenant_id, brand_id, channel_type, channel_connection_id, contact_id,
       subject, participant_value, normalized_participant_value,
       status, priority, last_message_at, last_inbound_at, last_outbound_at,
       unread_count, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,CURRENT_TIMESTAMP
     ) RETURNING *`,
    [
      params.tenantId,
      params.brandId || null,
      params.channelType,
      params.channelConnectionId || null,
      params.contactId || null,
      params.subject || null,
      params.participantValue,
      params.normalizedParticipantValue,
      params.status || 'OPEN',
      params.priority || 'NORMAL',
      params.lastMessageAt || null,
      params.lastInboundAt || null,
      params.lastOutboundAt || null,
      params.unreadCount || 0,
    ]
  );
  const row = result.rows[0];
  void emitConversationCreated(row);
  return row;
}

async function emitConversationCreated(row: any) {
  if (!row?.id || !row?.tenant_id) return;
  try {
    const { emitAutomationEvent } = await import('./automationEmitter');
    await emitAutomationEvent({
      tenantId: row.tenant_id,
      triggerType: 'CONVERSATION_CREATED',
      triggerEventId: `conversation:${row.id}:created`,
      payload: {
        conversationId: row.id,
        brandId: row.brand_id,
        channel: row.channel_type,
        contactId: row.contact_id,
        conversationStatus: row.status,
        conversationPriority: row.priority,
        subject: row.subject,
      },
    });
  } catch (err) {
    console.error('Automation CONVERSATION_CREATED emit error:', err);
  }
}

export async function touchConversationInbound(params: {
  conversationId: number;
  tenantId: number;
  at: Date;
  incrementUnread?: boolean;
  contactId?: number | null;
  subject?: string | null;
}): Promise<void> {
  await query(
    `UPDATE conversations
     SET last_message_at = GREATEST(COALESCE(last_message_at, $3), $3),
         last_inbound_at = GREATEST(COALESCE(last_inbound_at, $3), $3),
         unread_count = CASE WHEN $4 THEN unread_count + 1 ELSE unread_count END,
         contact_id = COALESCE(contact_id, $5),
         subject = COALESCE(subject, $6),
         status = CASE
           WHEN status = 'ARCHIVED' THEN status
           WHEN status = 'RESOLVED' THEN 'OPEN'
           ELSE status
         END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND tenant_id = $2`,
    [
      params.conversationId,
      params.tenantId,
      params.at,
      Boolean(params.incrementUnread),
      params.contactId || null,
      params.subject || null,
    ]
  );
}

export async function touchConversationOutbound(params: {
  conversationId: number;
  tenantId: number;
  at: Date;
  subject?: string | null;
}): Promise<void> {
  await query(
    `UPDATE conversations
     SET last_message_at = GREATEST(COALESCE(last_message_at, $3), $3),
         last_outbound_at = GREATEST(COALESCE(last_outbound_at, $3), $3),
         subject = COALESCE(subject, $4),
         status = CASE
           WHEN status IN ('ARCHIVED', 'RESOLVED') THEN status
           ELSE 'WAITING_REPLY'
         END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND tenant_id = $2`,
    [params.conversationId, params.tenantId, params.at, params.subject || null]
  );
}

/**
 * Link inbound email to a conversation (create or match by headers).
 */
export async function linkInboundEmailToConversation(params: {
  tenantId: number;
  mailId: number;
  accountId: number;
  messageId: string;
  inReplyTo?: string | null;
  referencesHeader?: string | null;
  fromAddress: string;
  subject?: string | null;
  receivedAt: Date;
}): Promise<number | null> {
  const refs = parseReferencesHeader(params.referencesHeader);
  let conversationId = await findEmailConversationByHeaders({
    tenantId: params.tenantId,
    inReplyTo: params.inReplyTo,
    references: refs,
  });

  const participant = await normalizeParticipant({
    tenantId: params.tenantId,
    channelType: 'EMAIL',
    value: params.fromAddress,
  });
  if (!participant) return null;

  const contactId = await resolveContactIdByParticipant({
    tenantId: params.tenantId,
    channelType: 'EMAIL',
    normalizedValue: participant.normalized,
  });

  const brandInfo = await resolveBrandForMailAccount(params.tenantId, params.accountId);

  if (!conversationId) {
    const created = await createConversation({
      tenantId: params.tenantId,
      brandId: brandInfo.brandId,
      channelType: 'EMAIL',
      channelConnectionId: brandInfo.connectionId,
      contactId,
      subject: params.subject || null,
      participantValue: participant.participantValue,
      normalizedParticipantValue: participant.normalized,
      lastMessageAt: params.receivedAt,
      lastInboundAt: params.receivedAt,
      unreadCount: 1,
      status: 'OPEN',
    });
    conversationId = created.id;
  } else {
    await touchConversationInbound({
      conversationId,
      tenantId: params.tenantId,
      at: params.receivedAt,
      incrementUnread: true,
      contactId,
      subject: params.subject || null,
    });
  }

  await query(
    `UPDATE mails
     SET conversation_id = $1,
         in_reply_to = COALESCE($2, in_reply_to),
         mail_references = COALESCE($3, mail_references)
     WHERE id = $4 AND tenant_id = $5`,
    [
      conversationId,
      normalizeMessageId(params.inReplyTo),
      params.referencesHeader || null,
      params.mailId,
      params.tenantId,
    ]
  );

  return conversationId;
}

/**
 * Find or create WhatsApp/SMS conversation by connection + normalized phone.
 */
export async function ensurePhoneChannelConversation(params: {
  tenantId: number;
  brandId?: number | null;
  channelType: 'SMS' | 'WHATSAPP';
  channelConnectionId: number | null;
  phoneRaw: string;
  contactId?: number | null;
  subject?: string | null;
}): Promise<any | null> {
  const participant = await normalizeParticipant({
    tenantId: params.tenantId,
    channelType: params.channelType,
    value: params.phoneRaw,
  });
  if (!participant) return null;

  const contactId =
    params.contactId ||
    (await resolveContactIdByParticipant({
      tenantId: params.tenantId,
      channelType: params.channelType,
      normalizedValue: participant.normalized,
    }));

  const existing = await findChannelConversation({
    tenantId: params.tenantId,
    channelType: params.channelType,
    channelConnectionId: params.channelConnectionId,
    normalizedParticipant: participant.normalized,
  });

  if (existing) {
    if (!existing.contact_id && contactId) {
      await query(
        `UPDATE conversations SET contact_id = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND tenant_id = $3 AND contact_id IS NULL`,
        [contactId, existing.id, params.tenantId]
      );
      existing.contact_id = contactId;
    }
    return existing;
  }

  return createConversation({
    tenantId: params.tenantId,
    brandId: params.brandId || null,
    channelType: params.channelType,
    channelConnectionId: params.channelConnectionId,
    contactId,
    subject: params.subject || null,
    participantValue: participant.participantValue,
    normalizedParticipantValue: participant.normalized,
    status: 'OPEN',
  });
}

export async function linkInboundWhatsAppMessage(params: {
  tenantId: number;
  brandId: number | null;
  channelConnectionId: number;
  inboundMessageId: number;
  fromPhone: string;
  contactId?: number | null;
  receivedAt: Date;
}): Promise<number | null> {
  const conversation = await ensurePhoneChannelConversation({
    tenantId: params.tenantId,
    brandId: params.brandId,
    channelType: 'WHATSAPP',
    channelConnectionId: params.channelConnectionId,
    phoneRaw: params.fromPhone,
    contactId: params.contactId || null,
  });
  if (!conversation) return null;

  await touchConversationInbound({
    conversationId: conversation.id,
    tenantId: params.tenantId,
    at: params.receivedAt,
    incrementUnread: true,
    contactId: params.contactId || null,
  });

  await query(
    `UPDATE inbound_messages
     SET conversation_id = $1
     WHERE id = $2 AND tenant_id = $3 AND conversation_id IS NULL`,
    [conversation.id, params.inboundMessageId, params.tenantId]
  );

  return conversation.id;
}

export async function linkOutboundToConversation(params: {
  tenantId: number;
  outboundMessageId: number;
  channelType: ConversationChannel;
  brandId?: number | null;
  channelConnectionId?: number | null;
  recipientValue: string;
  contactId?: number | null;
  subject?: string | null;
  conversationId?: number | null;
  at?: Date;
}): Promise<number | null> {
  const at = params.at || new Date();
  let conversationId = params.conversationId || null;

  if (conversationId) {
    const owned = await getOwnedConversation(conversationId, params.tenantId);
    if (!owned) return null;
  } else if (params.channelType === 'EMAIL') {
    const participant = await normalizeParticipant({
      tenantId: params.tenantId,
      channelType: 'EMAIL',
      value: params.recipientValue,
    });
    if (!participant) return null;
    const contactId =
      params.contactId ||
      (await resolveContactIdByParticipant({
        tenantId: params.tenantId,
        channelType: 'EMAIL',
        normalizedValue: participant.normalized,
      }));
    const existingEmail = await query(
      `SELECT id FROM conversations
       WHERE tenant_id = $1
         AND channel_type = 'EMAIL'
         AND normalized_participant_value = $2
         AND status <> 'ARCHIVED'
         AND ($3::int IS NULL OR brand_id = $3 OR brand_id IS NULL)
       ORDER BY last_message_at DESC NULLS LAST, id DESC
       LIMIT 1`,
      [params.tenantId, participant.normalized, params.brandId || null]
    );
    if (existingEmail.rows[0]) {
      conversationId = existingEmail.rows[0].id;
    } else {
      const created = await createConversation({
        tenantId: params.tenantId,
        brandId: params.brandId || null,
        channelType: 'EMAIL',
        channelConnectionId: params.channelConnectionId || null,
        contactId,
        subject: params.subject || null,
        participantValue: participant.participantValue,
        normalizedParticipantValue: participant.normalized,
        lastMessageAt: at,
        lastOutboundAt: at,
        status: 'WAITING_REPLY',
      });
      conversationId = created.id;
    }
  } else {
    const conversation = await ensurePhoneChannelConversation({
      tenantId: params.tenantId,
      brandId: params.brandId || null,
      channelType: params.channelType,
      channelConnectionId: params.channelConnectionId || null,
      phoneRaw: params.recipientValue,
      contactId: params.contactId || null,
      subject: params.subject || null,
    });
    if (!conversation) return null;
    conversationId = conversation.id;
  }

  await query(
    `UPDATE outbound_messages
     SET conversation_id = $1
     WHERE id = $2 AND tenant_id = $3`,
    [conversationId, params.outboundMessageId, params.tenantId]
  );

  await touchConversationOutbound({
    conversationId,
    tenantId: params.tenantId,
    at,
    subject: params.subject || null,
  });

  return conversationId;
}

export async function markConversationRead(params: {
  conversationId: number;
  tenantId: number;
}): Promise<any | null> {
  const conv = await getOwnedConversation(params.conversationId, params.tenantId);
  if (!conv) return null;

  await query(
    `UPDATE conversations
     SET unread_count = 0, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND tenant_id = $2`,
    [params.conversationId, params.tenantId]
  );

  if (conv.channel_type === 'EMAIL') {
    await query(
      `UPDATE mails
       SET is_read = true
       WHERE conversation_id = $1 AND tenant_id = $2 AND COALESCE(is_sent, false) = false`,
      [params.conversationId, params.tenantId]
    );
  }

  return getOwnedConversation(params.conversationId, params.tenantId);
}

export function sanitizeConversationRow(row: any) {
  if (!row) return row;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    brand_id: row.brand_id,
    brand_name: row.brand_name || null,
    brand_accent_color: row.brand_accent_color || null,
    channel_type: row.channel_type,
    channel_connection_id: row.channel_connection_id,
    contact_id: row.contact_id,
    contact_display_name: row.contact_display_name || null,
    subject: row.subject,
    participant_value: row.participant_value,
    normalized_participant_value: row.normalized_participant_value,
    status: row.status,
    priority: row.priority,
    assigned_user_id: row.assigned_user_id,
    assigned_user_name: row.assigned_user_name || null,
    assigned_user_email: row.assigned_user_email || null,
    last_message_at: row.last_message_at,
    last_inbound_at: row.last_inbound_at,
    last_outbound_at: row.last_outbound_at,
    unread_count: row.unread_count || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_message_preview: row.last_message_preview || null,
  };
}
