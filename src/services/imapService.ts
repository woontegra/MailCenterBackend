import { ImapFlow } from 'imapflow';
import { getImapIdleTimingMs } from '../config/imapIdleConfig';
import { MailAccount, FetchedMessage } from '../types';

export interface MailboxMeta {
  uidValidity: number;
  uidNext: number;
  exists: number;
}

export interface UidFetchResult {
  messages: FetchedMessage[];
  meta: MailboxMeta;
  highestUid: number;
}

function normalizeMessageId(raw: string | undefined, accountId: number, uid: number): string {
  const cleaned = (raw || '').trim();
  if (cleaned) return cleaned;
  return `<imap-${accountId}-${uid}@mailcenter.local>`;
}

export function mapImapMessage(msg: any, accountId: number): FetchedMessage | null {
  const envelope = msg.envelope;
  if (!envelope || !msg.uid) return null;

  const headerMap = msg.headers;
  let referencesHeader: string | null = null;
  let inReplyTo: string | null = envelope.inReplyTo || null;
  let headerMessageId: string | undefined = envelope.messageId;

  try {
    if (headerMap && typeof headerMap.get === 'function') {
      const refs = headerMap.get('references');
      if (refs) {
        referencesHeader = Array.isArray(refs) ? refs.join(' ') : String(refs);
      }
      const irt = headerMap.get('in-reply-to');
      if (irt && !inReplyTo) {
        inReplyTo = Array.isArray(irt) ? String(irt[0]) : String(irt);
      }
      const mid = headerMap.get('message-id');
      if (mid && !headerMessageId) {
        headerMessageId = Array.isArray(mid) ? String(mid[0]) : String(mid);
      }
    }
  } catch {
    /* ignore header parse */
  }

  return {
    uid: msg.uid,
    messageId: normalizeMessageId(headerMessageId, accountId, msg.uid),
    subject: envelope.subject || '(No Subject)',
    from: envelope.from?.[0]?.address || 'unknown',
    to: envelope.to?.map((t: any) => t.address).filter(Boolean).join(', ') || '',
    date: envelope.date || new Date(),
    bodyPreview: '',
    headers: envelope,
    envelope,
    inReplyTo: inReplyTo || null,
    references: referencesHeader,
  };
}

export function isImapAuthError(error: unknown): boolean {
  const err = error as { authenticationFailed?: boolean; responseText?: string; message?: string; code?: string };
  if (err?.authenticationFailed) return true;
  const text = `${err?.responseText || ''} ${err?.message || ''} ${err?.code || ''}`.toLowerCase();
  return /auth|invalid credentials|login failed|authentication failed|invalid user|password/.test(text);
}

export function safeImapErrorMessage(error: unknown): string {
  const err = error as { message?: string; responseText?: string; code?: string };
  if (isImapAuthError(error)) {
    return 'IMAP kimlik doğrulama başarısız. Hesap bilgilerini kontrol edin.';
  }
  const raw = String(err?.responseText || err?.message || err?.code || 'IMAP bağlantı hatası');
  return raw
    .replace(/pass(word)?[=:].*/gi, '[redacted]')
    .replace(/auth[=:].*/gi, '[redacted]')
    .slice(0, 300);
}

export function createImapClient(account: MailAccount): ImapFlow {
  const { maxIdleTime, socketTimeout } = getImapIdleTimingMs();
  return new ImapFlow({
    host: account.imap_host,
    port: account.imap_port,
    secure: account.imap_secure !== false,
    auth: {
      user: account.imap_user,
      pass: account.imap_password,
    },
    logger: false,
    maxIdleTime,
    socketTimeout,
    // Use a single controlled IDLE loop; disabling auto-idle prevents ImapFlow's
    // internal idle timer from racing with our explicit idle() loop (which caused
    // idle() to return immediately when this.idling was already true).
    disableAutoIdle: true,
  });
}

export interface OpenMailboxInfo {
  path: string;
  uidValidity: number;
  uidNext: number;
  exists: number;
}

/**
 * Opens INBOX (SELECT) and returns its live state. Throws if the mailbox is not
 * properly selected, so callers can avoid marking a connection IDLE prematurely.
 */
export async function openInbox(client: ImapFlow): Promise<OpenMailboxInfo> {
  const mailbox = await client.mailboxOpen('INBOX');
  if (!client.mailbox || client.mailbox.path !== 'INBOX') {
    throw new Error('INBOX could not be selected');
  }
  const uidValidity = Number(mailbox.uidValidity || client.mailbox.uidValidity || 0);
  if (!uidValidity) {
    throw new Error('INBOX opened without UIDVALIDITY');
  }
  return {
    path: 'INBOX',
    uidValidity,
    uidNext: Number(mailbox.uidNext || client.mailbox.uidNext || 1),
    exists: Number(mailbox.exists ?? client.mailbox.exists ?? 0),
  };
}

/** True only when INBOX is currently selected on this client. */
export function isInboxOpen(client: ImapFlow): boolean {
  return Boolean(client.mailbox && client.mailbox.path === 'INBOX');
}

export async function readMailboxMeta(client: ImapFlow): Promise<MailboxMeta> {
  const status = await client.status('INBOX', {
    messages: true,
    uidNext: true,
    uidValidity: true,
  });
  return {
    uidValidity: Number(status.uidValidity || 0),
    uidNext: Number(status.uidNext || 1),
    exists: Number(status.messages || 0),
  };
}

export async function downloadBodyPreview(client: ImapFlow, uid: number): Promise<string> {
  try {
    const { content } = await client.download(String(uid), '1', { maxBytes: 500, uid: true });
    let text = '';
    for await (const chunk of content) {
      text += chunk.toString();
    }
    return text
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 200);
  } catch {
    return '';
  }
}

export async function fetchMessagesByUidRange(
  client: ImapFlow,
  accountId: number,
  sinceUid: number
): Promise<UidFetchResult> {
  const meta = await readMailboxMeta(client);
  const messages: FetchedMessage[] = [];
  let highestUid = sinceUid;

  if (meta.exists === 0) {
    return { messages, meta, highestUid };
  }

  const range = sinceUid > 0 ? `${sinceUid + 1}:*` : '1:*';
  // When sinceUid is 0 on a large mailbox, cap initial catch-up to recent UIDs via uidNext window
  const fetchRange =
    sinceUid <= 0 && meta.uidNext > 51
      ? `${Math.max(1, meta.uidNext - 50)}:*`
      : range;

  try {
    for await (const msg of client.fetch(
      fetchRange,
      {
        envelope: true,
        headers: ['references', 'in-reply-to', 'message-id'],
      },
      { uid: true }
    )) {
      const mapped = mapImapMessage(msg, accountId);
      if (!mapped || !mapped.uid) continue;
      if (sinceUid > 0 && mapped.uid <= sinceUid) continue;
      if (mapped.uid > highestUid) highestUid = mapped.uid;
      messages.push(mapped);
    }
  } catch (error: any) {
    // Empty range (no messages after UID) is normal
    const text = String(error?.message || '');
    if (!/nothing to fetch|no messages|empty/i.test(text)) {
      throw error;
    }
  }

  messages.sort((a, b) => (a.uid || 0) - (b.uid || 0));

  // IMPORTANT: ImapFlow fetch iterators must not run nested IMAP commands inside
  // the `for await (... of client.fetch())` loop; doing so deadlocks the FETCH
  // command and startup reconciliation never completes. Download previews only
  // after the FETCH iterator has fully finished.
  for (const message of messages) {
    if (!message.uid) continue;
    message.bodyPreview = await downloadBodyPreview(client, message.uid);
  }

  return { messages, meta, highestUid };
}

export class ImapService {
  private client: ImapFlow | null = null;

  async connect(account: MailAccount): Promise<void> {
    try {
      this.client = createImapClient(account);
      await this.client.connect();
      console.log(`✓ Connected to IMAP account #${account.id}`);
    } catch (error: any) {
      console.error(`✗ Failed to connect to IMAP account #${account.id}:`, safeImapErrorMessage(error));
      throw error;
    }
  }

  getClient(): ImapFlow {
    if (!this.client) throw new Error('IMAP client not connected');
    return this.client;
  }

  async fetchUidRange(accountId: number, sinceUid: number): Promise<UidFetchResult> {
    if (!this.client) throw new Error('IMAP client not connected');
    const lock = await this.client.getMailboxLock('INBOX');
    try {
      return await fetchMessagesByUidRange(this.client, accountId, sinceUid);
    } finally {
      lock.release();
    }
  }

  /** @deprecated Prefer fetchUidRange. Kept for compatibility; now returns UIDs. */
  async fetchRecentMails(limit: number = 50): Promise<FetchedMessage[]> {
    if (!this.client) throw new Error('IMAP client not connected');
    const lock = await this.client.getMailboxLock('INBOX');
    try {
      const meta = await readMailboxMeta(this.client);
      if (!meta.exists) return [];
      const sinceUid = Math.max(0, meta.uidNext - limit - 1);
      const result = await fetchMessagesByUidRange(this.client, 0, sinceUid);
      return result.messages.slice(-limit).reverse();
    } finally {
      lock.release();
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        try {
          this.client.close();
        } catch {
          /* ignore */
        }
      }
      this.client = null;
    }
  }
}
