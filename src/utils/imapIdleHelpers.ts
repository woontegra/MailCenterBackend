import { MailAccount } from '../types';

/**
 * An `exists` notification only implies new messages to fetch when the mailbox
 * message count actually increased. Deletions/expunges lower the count and must
 * not trigger a fetch.
 */
export function shouldFetchOnExists(count: number, prevCount: number): boolean {
  return Number(count) > Number(prevCount);
}

/**
 * Deterministic fingerprint of the fields that actually affect the IMAP
 * connection. Used so the account config watch (and ACCOUNT_UPDATED events) only
 * restart a listener when a real connection setting changed — not on every
 * unrelated column update (e.g. last_sync_uid, updated_at, counters).
 */
export function connectionFingerprint(account: MailAccount): string {
  const a = account as unknown as Record<string, unknown>;
  const parts = [
    account.imap_host ?? '',
    account.imap_port ?? '',
    account.imap_secure !== false ? '1' : '0',
    account.imap_user ?? '',
    // credential material: prefer encrypted blob, fall back to legacy password
    a.encrypted_credentials ?? a.imap_password ?? '',
    account.is_active ? '1' : '0',
  ];
  return parts.map((p) => String(p)).join('|');
}
