import { query } from '../config/database';
import { sanitizeOutboundErrorMessage } from '../config/outboundQueue';

export type TimelineItem = {
  sourceId: string;
  direction: 'INBOUND' | 'OUTBOUND';
  channelType: string;
  sender: string | null;
  recipient: string | null;
  subject: string | null;
  content: string | null;
  contentType: string;
  status: string | null;
  providerMessageId: string | null;
  sentAt: string | null;
  receivedAt: string | null;
  attachments: Array<{ filename?: string; contentType?: string; sizeBytes?: number }>;
  isRead: boolean;
  safeErrorMessage: string | null;
};

function stripHtml(html: string): string {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function getConversationTimeline(params: {
  conversationId: number;
  tenantId: number;
  channelType: string;
}): Promise<TimelineItem[]> {
  const items: TimelineItem[] = [];

  if (params.channelType === 'EMAIL') {
    const mails = await query(
      `SELECT m.id, m.subject, m.from_address, m.to_address, m.body_preview,
              m.date, m.is_read, m.is_sent, m.message_id, m.status
       FROM mails m
       WHERE m.conversation_id = $1 AND m.tenant_id = $2
       ORDER BY m.date ASC NULLS LAST, m.id ASC`,
      [params.conversationId, params.tenantId]
    );

    for (const m of mails.rows) {
      const outbound = Boolean(m.is_sent);
      items.push({
        sourceId: `mail:${m.id}`,
        direction: outbound ? 'OUTBOUND' : 'INBOUND',
        channelType: 'EMAIL',
        sender: m.from_address || null,
        recipient: m.to_address || null,
        subject: m.subject || null,
        content: m.body_preview || null,
        contentType: 'text/plain',
        status: outbound ? 'SENT' : m.is_read ? 'READ' : 'RECEIVED',
        providerMessageId: m.message_id || null,
        sentAt: outbound ? m.date : null,
        receivedAt: outbound ? null : m.date,
        attachments: [],
        isRead: Boolean(m.is_read) || outbound,
        safeErrorMessage: null,
      });
    }
  }

  if (params.channelType === 'WHATSAPP') {
    const inbound = await query(
      `SELECT id, sender_value, recipient_value, provider_message_id, message_type,
              content, media_metadata, received_at, status
       FROM inbound_messages
       WHERE conversation_id = $1 AND tenant_id = $2 AND channel_type = 'WHATSAPP'
       ORDER BY received_at ASC, id ASC`,
      [params.conversationId, params.tenantId]
    );
    for (const row of inbound.rows) {
      const isMedia = row.message_type && row.message_type !== 'text';
      const meta = row.media_metadata || {};
      items.push({
        sourceId: `inbound:${row.id}`,
        direction: 'INBOUND',
        channelType: 'WHATSAPP',
        sender: row.sender_value || null,
        recipient: row.recipient_value || null,
        subject: null,
        content: isMedia ? 'Medya mesajı' : row.content || null,
        contentType: isMedia ? 'media' : 'text/plain',
        status: row.status || 'RECEIVED',
        providerMessageId: row.provider_message_id || null,
        sentAt: null,
        receivedAt: row.received_at,
        attachments: isMedia
          ? [
              {
                filename: meta.filename || undefined,
                contentType: meta.mime_type || meta.mimeType || undefined,
                sizeBytes: meta.file_size || meta.fileSize || undefined,
              },
            ]
          : [],
        isRead: true,
        safeErrorMessage: null,
      });
    }
  }

  // Outbound for all channels linked to conversation
  // SMS: only outbound (no fake inbound)
  const outbound = await query(
    `SELECT id, channel_type, recipient_data, subject, message_content, plain_text_content,
            html_content, status, provider_message_id, last_error_message,
            queued_at, sent_at, created_at, failed_at
     FROM outbound_messages
     WHERE conversation_id = $1 AND tenant_id = $2
     ORDER BY COALESCE(sent_at, queued_at, created_at) ASC, id ASC`,
    [params.conversationId, params.tenantId]
  );

  for (const row of outbound.rows) {
    const recipients = row.recipient_data || {};
    const to = recipients.to || recipients.phone || null;
    let content =
      row.message_content || row.plain_text_content || stripHtml(row.html_content || '') || null;
    if (row.channel_type === 'EMAIL' && !content && row.subject) {
      content = row.subject;
    }
    items.push({
      sourceId: `outbound:${row.id}`,
      direction: 'OUTBOUND',
      channelType: row.channel_type,
      sender: null,
      recipient: to,
      subject: row.subject || null,
      content,
      contentType: row.html_content ? 'text/html' : 'text/plain',
      status: row.status || null,
      providerMessageId: row.provider_message_id || null,
      sentAt: row.sent_at || row.queued_at || row.created_at,
      receivedAt: null,
      attachments: [],
      isRead: true,
      safeErrorMessage: row.last_error_message
        ? sanitizeOutboundErrorMessage(row.last_error_message)
        : null,
    });
  }

  items.sort((a, b) => {
    const ta = new Date(a.sentAt || a.receivedAt || 0).getTime();
    const tb = new Date(b.sentAt || b.receivedAt || 0).getTime();
    if (ta !== tb) return ta - tb;
    return a.sourceId.localeCompare(b.sourceId);
  });

  return items;
}

export function previewFromTimeline(items: TimelineItem[]): string | null {
  if (!items.length) return null;
  const last = items[items.length - 1];
  const text = String(last.content || last.subject || '').trim();
  return text ? text.slice(0, 180) : null;
}
