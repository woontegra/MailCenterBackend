import { simpleParser, Attachment } from 'mailparser';

export type MailAttachmentMeta = {
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
  contentId?: string;
  disposition?: string;
  inline?: boolean;
};

export type ParsedMailBodies = {
  htmlBody: string | null;
  textBody: string | null;
  bodyPreview: string;
  ccAddress: string | null;
  attachments: MailAttachmentMeta[];
};

function stripTags(html: string): string {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCid(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/^<|>$/g, '')
    .toLowerCase();
}

function addressListToString(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value.trim() || null;

  // mailparser AddressObject: { value: Address[], text, html }
  const asObj = value as { text?: string; value?: unknown; address?: string; name?: string };
  if (typeof asObj.text === 'string' && asObj.text.trim()) {
    return asObj.text.trim();
  }
  if (Array.isArray(asObj.value)) {
    value = asObj.value;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item: any) => {
        if (!item) return '';
        if (typeof item === 'string') return item;
        if (item.address) {
          return item.name ? `${item.name} <${item.address}>` : String(item.address);
        }
        return '';
      })
      .filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  }

  if (asObj.address) {
    return asObj.name ? `${asObj.name} <${asObj.address}>` : String(asObj.address);
  }
  return null;
}

function rewriteCidToDataUrls(html: string, attachments: Attachment[]): string {
  const cidMap = new Map<string, string>();

  for (const att of attachments) {
    const cid = normalizeCid(att.contentId || '');
    if (!cid || !att.content || !att.contentType) continue;
    if (!/^image\//i.test(att.contentType)) continue;
    // Cap individual inline images (~1.5MB decoded) to avoid huge DB rows
    if (att.content.length > 1.5 * 1024 * 1024) continue;
    const b64 = Buffer.isBuffer(att.content)
      ? att.content.toString('base64')
      : Buffer.from(att.content).toString('base64');
    cidMap.set(cid, `data:${att.contentType};base64,${b64}`);
  }

  if (!cidMap.size) return html;

  return html.replace(/cid:([^"'>\s]+)/gi, (full, rawCid: string) => {
    const key = normalizeCid(rawCid);
    return cidMap.get(key) || full;
  });
}

function buildAttachmentMeta(attachments: Attachment[]): MailAttachmentMeta[] {
  return attachments.map((att) => {
    const disposition = String(att.contentDisposition || '').toLowerCase();
    const inline =
      disposition === 'inline' || Boolean(att.contentId && /^image\//i.test(att.contentType || ''));
    return {
      filename: att.filename || undefined,
      contentType: att.contentType || undefined,
      sizeBytes: att.size || (att.content ? att.content.length : undefined),
      contentId: att.contentId ? normalizeCid(att.contentId) : undefined,
      disposition: disposition || undefined,
      inline,
    };
  });
}

/**
 * Parse a full RFC822 buffer into html/text bodies without discarding HTML.
 */
export async function parseMimeMessageBuffer(raw: Buffer): Promise<ParsedMailBodies> {
  const parsed = await simpleParser(raw);
  const attachments = parsed.attachments || [];

  let htmlBody: string | null =
    typeof parsed.html === 'string' && parsed.html.trim() ? parsed.html : null;
  let textBody: string | null =
    typeof parsed.text === 'string' && parsed.text.trim() ? parsed.text : null;

  if (htmlBody) {
    htmlBody = rewriteCidToDataUrls(htmlBody, attachments);
  }

  if (!textBody && htmlBody) {
    textBody = stripTags(htmlBody);
  }

  const previewSource = textBody || (htmlBody ? stripTags(htmlBody) : '');
  const bodyPreview = previewSource.replace(/\s+/g, ' ').trim().slice(0, 200);

  return {
    htmlBody,
    textBody,
    bodyPreview,
    ccAddress: addressListToString(parsed.cc),
    attachments: buildAttachmentMeta(attachments),
  };
}

export function emptyParsedBodies(fallbackPreview = ''): ParsedMailBodies {
  return {
    htmlBody: null,
    textBody: null,
    bodyPreview: String(fallbackPreview || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200),
    ccAddress: null,
    attachments: [],
  };
}
