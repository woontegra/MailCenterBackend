import { query } from '../config/database';
import { sanitizeOutboundErrorMessage } from '../config/outboundQueue';
import { sanitizeEmailHtmlFragment } from '../utils/emailHtmlSanitizer';

export type TimelineAttachment = {
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
  contentId?: string;
  inline?: boolean;
};

export type TimelineItem = {
  sourceId: string;
  direction: 'INBOUND' | 'OUTBOUND';
  channelType: string;
  sender: string | null;
  recipient: string | null;
  cc: string | null;
  subject: string | null;
  content: string | null;
  contentType: string;
  htmlBody: string | null;
  textBody: string | null;
  sanitizedHtml: string | null;
  status: string | null;
  providerMessageId: string | null;
  sentAt: string | null;
  receivedAt: string | null;
  attachments: TimelineAttachment[];
  isRead: boolean;
  safeErrorMessage: string | null;
};

function stripHtml(html: string): string {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseAttachmentMeta(raw: unknown): TimelineAttachment[] {
  if (!raw) return [];
  let rows: any[] = [];
  if (Array.isArray(raw)) rows = raw;
  else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) rows = parsed;
    } catch {
      return [];
    }
  }
  return rows
    .filter((a) => a && !a.inline)
    .map((a) => ({
      filename: a.filename || undefined,
      contentType: a.contentType || a.content_type || undefined,
      sizeBytes: a.sizeBytes || a.size_bytes || undefined,
      contentId: a.contentId || a.content_id || undefined,
      inline: Boolean(a.inline),
    }));
}

function buildEmailBodies(params: {
  htmlBody?: string | null;
  textBody?: string | null;
  preview?: string | null;
}): Pick<TimelineItem, 'content' | 'contentType' | 'htmlBody' | 'textBody' | 'sanitizedHtml'> {
  const htmlRaw = params.htmlBody && String(params.htmlBody).trim() ? String(params.htmlBody) : null;
  const textRaw = params.textBody && String(params.textBody).trim() ? String(params.textBody) : null;
  const preview = params.preview && String(params.preview).trim() ? String(params.preview) : null;

  const sanitizedHtml = htmlRaw ? sanitizeEmailHtmlFragment(htmlRaw) : null;
  const textBody = textRaw || (sanitizedHtml ? stripHtml(sanitizedHtml) : null) || preview;
  const content = textBody || preview;
  const contentType = sanitizedHtml ? 'text/html' : 'text/plain';

  return {
    content,
    contentType,
    htmlBody: htmlRaw,
    textBody,
    sanitizedHtml,
  };
}

export async function getConversationTimeline(params: {
  conversationId: number;
  tenantId: number;
  channelType: string;
}): Promise<TimelineItem[]> {
  const items: TimelineItem[] = [];

  if (params.channelType === 'EMAIL') {
    const mails = await query(
      `SELECT m.id, m.subject, m.from_address, m.to_address, m.cc_address,
              m.body_preview, m.html_body, m.text_body, m.attachment_meta,
              m.date, m.is_read, m.is_sent, m.message_id, m.status
       FROM mails m
       WHERE m.conversation_id = $1 AND m.tenant_id = $2
       ORDER BY m.date ASC NULLS LAST, m.id ASC`,
      [params.conversationId, params.tenantId]
    );

    for (const m of mails.rows) {
      const outbound = Boolean(m.is_sent);
      const bodies = buildEmailBodies({
        htmlBody: m.html_body,
        textBody: m.text_body,
        preview: m.body_preview,
      });
      items.push({
        sourceId: `mail:${m.id}`,
        direction: outbound ? 'OUTBOUND' : 'INBOUND',
        channelType: 'EMAIL',
        sender: m.from_address || null,
        recipient: m.to_address || null,
        cc: m.cc_address || null,
        subject: m.subject || null,
        ...bodies,
        status: outbound ? 'SENT' : m.is_read ? 'READ' : 'RECEIVED',
        providerMessageId: m.message_id || null,
        sentAt: outbound ? m.date : null,
        receivedAt: outbound ? null : m.date,
        attachments: parseAttachmentMeta(m.attachment_meta),
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
        cc: null,
        subject: null,
        content: isMedia ? 'Medya mesajı' : row.content || null,
        contentType: isMedia ? 'media' : 'text/plain',
        htmlBody: null,
        textBody: isMedia ? null : row.content || null,
        sanitizedHtml: null,
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
    const isEmail = row.channel_type === 'EMAIL';
    const bodies = isEmail
      ? buildEmailBodies({
          htmlBody: row.html_content,
          textBody: row.plain_text_content || row.message_content,
          preview: row.message_content,
        })
      : {
          content:
            row.message_content ||
            row.plain_text_content ||
            stripHtml(row.html_content || '') ||
            null,
          contentType: 'text/plain' as const,
          htmlBody: null,
          textBody: row.message_content || row.plain_text_content || null,
          sanitizedHtml: null,
        };

    if (isEmail && !bodies.content && row.subject) {
      bodies.content = row.subject;
    }

    items.push({
      sourceId: `outbound:${row.id}`,
      direction: 'OUTBOUND',
      channelType: row.channel_type,
      sender: null,
      recipient: to,
      cc: recipients.cc || null,
      subject: row.subject || null,
      ...bodies,
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
  const text = String(last.textBody || last.content || last.subject || '').trim();
  return text ? text.slice(0, 180) : null;
}
