/**
 * Pure parsers for WhatsApp Business app coexistence webhook fields
 * (account_update, history, smb_app_state_sync, smb_message_echoes).
 * Payload shapes follow Meta "Onboarding WhatsApp Business app users" docs.
 */
import crypto from 'crypto';
import { extractMetaMessageContent } from './providers/metaWhatsAppCloudAdapter';

export const COEXISTENCE_WEBHOOK_FIELDS = [
  'account_update',
  'history',
  'smb_app_state_sync',
  'smb_message_echoes',
] as const;

export type CoexistenceWebhookField = (typeof COEXISTENCE_WEBHOOK_FIELDS)[number];

export const HISTORY_SHARING_DECLINED_CODE = 2593109;

export function isCoexistenceWebhookField(field: unknown): field is CoexistenceWebhookField {
  return (COEXISTENCE_WEBHOOK_FIELDS as readonly string[]).includes(String(field || ''));
}

export function phoneDigits(value: unknown): string {
  return String(value ?? '').replace(/\D/g, '');
}

function nonEmpty(value: unknown): string | null {
  const s = String(value ?? '').trim();
  return s ? s : null;
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Unix seconds (number or numeric string) → Date */
export function unixSecondsToDate(value: unknown): Date | null {
  const n = toFiniteNumber(value);
  if (n == null || n <= 0) return null;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type CoexistenceWebhookChange = {
  field: CoexistenceWebhookField;
  wabaId: string | null;
  phoneNumberId: string | null;
  eventName: string | null;
  entryTime: number | null;
  value: any;
  dedupeKey: string;
};

export function computeChangeDedupeKey(params: {
  field: string;
  wabaId: string | null;
  entryTime: number | null;
  value: unknown;
}): string {
  const material = JSON.stringify({
    f: params.field,
    w: params.wabaId,
    t: params.entryTime,
    v: params.value ?? null,
  });
  return crypto.createHash('sha256').update(material).digest('hex');
}

export function extractCoexistenceChanges(payload: unknown): CoexistenceWebhookChange[] {
  const root = payload as any;
  if (!root || root.object !== 'whatsapp_business_account') return [];
  const out: CoexistenceWebhookChange[] = [];
  const entries = Array.isArray(root.entry) ? root.entry : [];
  for (const entry of entries) {
    const wabaId = nonEmpty(entry?.id);
    const entryTime = toFiniteNumber(entry?.time);
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const field = change?.field;
      if (!isCoexistenceWebhookField(field)) continue;
      const value = change?.value && typeof change.value === 'object' ? change.value : {};
      out.push({
        field,
        wabaId,
        phoneNumberId: nonEmpty(value?.metadata?.phone_number_id),
        eventName: field === 'account_update' ? nonEmpty(value?.event) : null,
        entryTime,
        value,
        dedupeKey: computeChangeDedupeKey({ field, wabaId, entryTime, value }),
      });
    }
  }
  return out;
}

/** IDs used to find per-connection app secrets for signature fallback. */
export function collectWebhookRoutingIds(payload: unknown): {
  phoneNumberIds: string[];
  wabaIds: string[];
} {
  const root = payload as any;
  const phones = new Set<string>();
  const wabas = new Set<string>();
  const entries = Array.isArray(root?.entry) ? root.entry : [];
  for (const entry of entries) {
    const waba = nonEmpty(entry?.id);
    if (waba) wabas.add(waba);
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const pnid = nonEmpty(change?.value?.metadata?.phone_number_id);
      if (pnid) phones.add(pnid);
    }
  }
  return { phoneNumberIds: Array.from(phones), wabaIds: Array.from(wabas) };
}

export type CoexistenceMessageDirection = 'INBOUND' | 'OUTBOUND';

export type CoexistenceMessage = {
  providerMessageId: string;
  direction: CoexistenceMessageDirection;
  counterpartyDigits: string;
  timestamp: Date | null;
  messageType: string;
  textBody: string | null;
  mediaMetadata: Record<string, unknown> | null;
  isPlaceholder: boolean;
  historyStatus: string | null;
};

/**
 * Direction rules:
 *  - `to` is only present when the business sent the message (echo / history outgoing)
 *  - inside a history thread, thread.id is the WhatsApp user; any other sender is the business
 *  - otherwise compare `from` with the business display number
 */
export function normalizeCoexistenceMessage(
  msg: any,
  opts: {
    businessDigits?: string | null;
    threadUserId?: string | null;
    forceDirection?: CoexistenceMessageDirection;
  } = {}
): CoexistenceMessage | null {
  const providerMessageId = nonEmpty(msg?.id);
  if (!providerMessageId) return null;

  const fromDigits = phoneDigits(msg?.from);
  const toDigits = phoneDigits(msg?.to);
  const threadDigits = phoneDigits(opts.threadUserId);
  const businessDigits = phoneDigits(opts.businessDigits);

  let direction: CoexistenceMessageDirection;
  if (opts.forceDirection) direction = opts.forceDirection;
  else if (toDigits) direction = 'OUTBOUND';
  else if (threadDigits && fromDigits) direction = fromDigits === threadDigits ? 'INBOUND' : 'OUTBOUND';
  else if (businessDigits && fromDigits) direction = fromDigits === businessDigits ? 'OUTBOUND' : 'INBOUND';
  else direction = 'INBOUND';

  const counterpartyDigits =
    direction === 'OUTBOUND' ? toDigits || threadDigits : fromDigits || threadDigits;
  if (!counterpartyDigits) return null;

  const rawType = String(msg?.type || 'text');
  const isPlaceholder = rawType === 'media_placeholder';
  let messageType = rawType;
  let textBody: string | null;
  let mediaMetadata: Record<string, unknown> | null;

  if (isPlaceholder) {
    textBody = 'Medya mesajı';
    mediaMetadata = { media_type: 'placeholder', placeholder: true };
  } else {
    const content = extractMetaMessageContent(msg);
    messageType = content.type;
    textBody = content.textBody;
    mediaMetadata = content.mediaMetadata;
    const media = msg?.[rawType];
    if (mediaMetadata && media && typeof media === 'object') {
      if (media.caption) textBody = String(media.caption);
      if (media.id) mediaMetadata = { ...mediaMetadata, media_id: String(media.id) };
      if (media.filename) mediaMetadata = { ...mediaMetadata, filename: String(media.filename) };
    }
  }

  return {
    providerMessageId,
    direction,
    counterpartyDigits,
    timestamp: unixSecondsToDate(msg?.timestamp),
    messageType,
    textBody,
    mediaMetadata,
    isPlaceholder,
    historyStatus: nonEmpty(msg?.history_context?.status)?.toUpperCase() || null,
  };
}

export type ParsedHistoryChunk = {
  phase: number | null;
  chunkOrder: number | null;
  progress: number | null;
  declined: boolean;
  errorCodes: number[];
  threadCount: number;
  messages: CoexistenceMessage[];
};

export function parseHistoryValue(value: any): {
  businessDigits: string;
  chunks: ParsedHistoryChunk[];
  mediaMessages: CoexistenceMessage[];
} {
  const businessDigits = phoneDigits(value?.metadata?.display_phone_number);
  const chunks: ParsedHistoryChunk[] = [];
  const historyItems = Array.isArray(value?.history) ? value.history : [];

  for (const item of historyItems) {
    const errors = Array.isArray(item?.errors) ? item.errors : [];
    const errorCodes = errors
      .map((e: any) => toFiniteNumber(e?.code))
      .filter((c: number | null): c is number => c != null);
    const threads = Array.isArray(item?.threads) ? item.threads : [];
    const messages: CoexistenceMessage[] = [];
    for (const thread of threads) {
      const threadUserId = nonEmpty(thread?.id);
      const threadMessages = Array.isArray(thread?.messages) ? thread.messages : [];
      for (const msg of threadMessages) {
        const normalized = normalizeCoexistenceMessage(msg, { businessDigits, threadUserId });
        if (normalized) messages.push(normalized);
      }
    }
    chunks.push({
      phase: toFiniteNumber(item?.metadata?.phase),
      chunkOrder: toFiniteNumber(item?.metadata?.chunk_order),
      progress: toFiniteNumber(item?.metadata?.progress),
      declined: errorCodes.includes(HISTORY_SHARING_DECLINED_CODE),
      errorCodes,
      threadCount: threads.length,
      messages,
    });
  }

  // Media asset follow-ups arrive as message-shaped `history` webhooks (last 14 days only).
  const mediaMessages: CoexistenceMessage[] = [];
  const rawMessages = Array.isArray(value?.messages) ? value.messages : [];
  for (const msg of rawMessages) {
    const normalized = normalizeCoexistenceMessage(msg, { businessDigits });
    if (normalized) mediaMessages.push(normalized);
  }

  return { businessDigits, chunks, mediaMessages };
}

export function parseMessageEchoes(value: any): CoexistenceMessage[] {
  const echoes = Array.isArray(value?.message_echoes) ? value.message_echoes : [];
  const out: CoexistenceMessage[] = [];
  for (const msg of echoes) {
    const normalized = normalizeCoexistenceMessage(msg, { forceDirection: 'OUTBOUND' });
    if (normalized) out.push(normalized);
  }
  return out;
}

export type ParsedStateSyncContact = {
  action: 'add' | 'remove' | string;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  phoneDigits: string;
  timestamp: Date | null;
};

export function splitContactName(fullName: string | null, firstName: string | null) {
  const full = String(fullName || '').trim().replace(/\s+/g, ' ');
  const first = String(firstName || '').trim();
  if (first) {
    const rest = full.toLowerCase().startsWith(first.toLowerCase())
      ? full.slice(first.length).trim()
      : '';
    return { firstName: first.slice(0, 120), lastName: rest ? rest.slice(0, 120) : null };
  }
  if (!full) return { firstName: null, lastName: null };
  const parts = full.split(' ');
  if (parts.length === 1) return { firstName: parts[0].slice(0, 120), lastName: null };
  return {
    firstName: parts.slice(0, -1).join(' ').slice(0, 120),
    lastName: parts[parts.length - 1].slice(0, 120),
  };
}

export function parseStateSync(value: any): ParsedStateSyncContact[] {
  const items = Array.isArray(value?.state_sync) ? value.state_sync : [];
  const out: ParsedStateSyncContact[] = [];
  for (const item of items) {
    if (String(item?.type || '') !== 'contact') continue;
    const digits = phoneDigits(item?.contact?.phone_number);
    if (digits.length < 8 || digits.length > 15) continue;
    const fullName = nonEmpty(item?.contact?.full_name);
    const names = splitContactName(fullName, nonEmpty(item?.contact?.first_name));
    out.push({
      action: String(item?.action || '').toLowerCase(),
      fullName,
      firstName: names.firstName,
      lastName: names.lastName,
      phoneDigits: digits,
      timestamp: unixSecondsToDate(item?.metadata?.timestamp),
    });
  }
  return out;
}

export const COEXISTENCE_DISCONNECT_EVENTS = new Set(['PARTNER_REMOVED', 'ACCOUNT_OFFBOARDED']);
export const COEXISTENCE_RECONNECT_EVENTS = new Set(['ACCOUNT_RECONNECTED']);

export type ParsedAccountUpdate = {
  event: string | null;
  phoneDigits: string | null;
  reason: string | null;
  initiatedBy: string | null;
  occurredAt: Date | null;
};

export function parseAccountUpdate(change: Pick<CoexistenceWebhookChange, 'value' | 'entryTime'>): ParsedAccountUpdate {
  const value = change.value || {};
  const info = value.disconnection_info && typeof value.disconnection_info === 'object'
    ? value.disconnection_info
    : {};
  return {
    event: nonEmpty(value.event)?.toUpperCase() || null,
    phoneDigits: phoneDigits(value.phone_number) || null,
    reason: nonEmpty(info.reason)?.toUpperCase() || null,
    initiatedBy: nonEmpty(info.initiated_by)?.toUpperCase() || null,
    occurredAt: unixSecondsToDate(change.entryTime),
  };
}

const DISCONNECT_REASON_LABELS: Record<string, string> = {
  ACCOUNT_DISCONNECTED: 'Hesap bağlantısı kesildi (yaptırım veya hesap silme)',
  BUSINESS_DOWNGRADE: 'Numara normal WhatsApp uygulamasına kaydedildi',
  CHANGE_NUMBER: 'İşletme telefon numarasını değiştirdi',
  COMPANION_INACTIVITY: 'Bağlı cihaz yaklaşık 30 gündür aktif değil',
  PRIMARY_INACTIVITY: 'Ana telefon yaklaşık 14 gündür aktif değil',
  USER_RE_REGISTERED: 'Numara başka bir cihazda yeniden kaydedildi',
};

export function describeDisconnectReason(reason: string | null | undefined): string {
  const key = String(reason || '').toUpperCase();
  return DISCONNECT_REASON_LABELS[key] || (key ? key : 'Bilinmeyen neden');
}

/**
 * Result of a read-only GET /{phone-number-id}?fields=is_on_biz_app,platform_type.
 * Meta does not document the post-offboarding values, so only unambiguous answers count:
 * NOT_ON_CLOUD_API = successful read with a platform_type other than CLOUD_API.
 */
export type CoexistenceLiveState = 'COEXISTENCE_ACTIVE' | 'CLOUD_ONLY' | 'NOT_ON_CLOUD_API' | 'UNKNOWN';

export function classifyCoexistenceLookup(
  lookup: { isOnBizApp: boolean | null; platformType: string | null } | null
): CoexistenceLiveState {
  if (!lookup) return 'UNKNOWN';
  const platform = String(lookup.platformType || '').trim().toUpperCase();
  if (!platform) return 'UNKNOWN';
  if (platform !== 'CLOUD_API') return 'NOT_ON_CLOUD_API';
  if (lookup.isOnBizApp === true) return 'COEXISTENCE_ACTIVE';
  if (lookup.isOnBizApp === false) return 'CLOUD_ONLY';
  return 'UNKNOWN';
}

/** history_context.status → outbound_messages.status */
export function mapHistoryStatusToOutbound(status: string | null): 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' {
  switch (String(status || '').toUpperCase()) {
    case 'READ':
    case 'PLAYED':
      return 'READ';
    case 'DELIVERED':
      return 'DELIVERED';
    case 'ERROR':
      return 'FAILED';
    default:
      return 'SENT';
  }
}
