import { query } from '../config/database';
import { MailAccount } from '../types';
import {
  assertMailCredentialsEncryptionConfigured,
  decryptCredential,
  encryptCredential,
  isLegacyPlaintextCredential,
} from './mailCredentialsCrypto';

const SENSITIVE_ACCOUNT_FIELDS = [
  'imap_password',
  'smtp_password',
  'access_token',
  'refresh_token',
] as const;

export const PUBLIC_MAIL_ACCOUNT_FIELDS = `
  id, name, email, company_name,
  imap_host, imap_port, imap_user, imap_secure,
  smtp_host, smtp_port, smtp_user, smtp_secure,
  tenant_id, is_active, provider, auth_type,
  token_expires_at, last_sync_uid, last_sync_at,
  sync_status, sync_error,
  imap_connection_status, smtp_connection_status, last_connection_test_at,
  imap_uidvalidity, last_inbound_at, imap_idle_status, imap_idle_error,
  imap_connected_at, imap_listener_active,
  created_at, updated_at
`.replace(/\s+/g, ' ').trim();

export const ACCOUNT_LIST_SELECT = `
  ma.id, ma.name, ma.email, ma.company_name,
  ma.imap_host, ma.imap_port, ma.imap_user, ma.imap_secure,
  ma.smtp_host, ma.smtp_port, ma.smtp_user, ma.smtp_secure,
  ma.tenant_id, ma.is_active, ma.provider, ma.auth_type,
  ma.token_expires_at, ma.last_sync_uid, ma.last_sync_at,
  ma.sync_status, ma.sync_error,
  ma.imap_connection_status, ma.smtp_connection_status, ma.last_connection_test_at,
  ma.imap_uidvalidity, ma.last_inbound_at, ma.imap_idle_status, ma.imap_idle_error,
  ma.imap_connected_at, ma.imap_listener_active,
  ma.created_at, ma.updated_at,
  b.id AS brand_id,
  b.name AS brand_name,
  b.accent_color AS brand_accent_color,
  cc.id AS channel_connection_id,
  cc.status AS channel_status,
  cc.last_tested_at AS channel_last_tested_at,
  si.id AS sender_identity_id,
  si.display_name AS sender_display_name,
  si.reply_to AS reply_to
`.replace(/\s+/g, ' ').trim();

export function sanitizeMailAccount<T extends Record<string, unknown>>(
  account: T
): Omit<T, (typeof SENSITIVE_ACCOUNT_FIELDS)[number]> {
  const sanitized = { ...account };
  for (const field of SENSITIVE_ACCOUNT_FIELDS) {
    delete sanitized[field];
  }
  return sanitized;
}

export function sanitizeMailAccounts(accounts: Record<string, unknown>[]): Record<string, unknown>[] {
  return accounts.map((account) => sanitizeMailAccount(account));
}

export function withDecryptedCredentials(account: MailAccount): MailAccount {
  return {
    ...account,
    imap_password: decryptCredential(account.imap_password) || '',
    smtp_password: decryptCredential(account.smtp_password ?? null) ?? undefined,
  };
}

export function requireMailCredentialEncryption(): void {
  assertMailCredentialsEncryptionConfigured();
}

export function isProductionWithoutEncryptionKey(): boolean {
  if (process.env.NODE_ENV !== 'production') {
    return false;
  }
  try {
    assertMailCredentialsEncryptionConfigured();
    return false;
  } catch {
    return true;
  }
}

export async function migrateLegacyCredentials(accountId: number, tenantId: number): Promise<void> {
  const result = await query(
    'SELECT imap_password, smtp_password FROM mail_accounts WHERE id = $1 AND tenant_id = $2',
    [accountId, tenantId]
  );

  if (result.rows.length === 0) {
    return;
  }

  const row = result.rows[0];
  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (isLegacyPlaintextCredential(row.imap_password)) {
    updates.push(`imap_password = $${paramIndex++}`);
    values.push(encryptCredential(row.imap_password));
  }

  if (isLegacyPlaintextCredential(row.smtp_password)) {
    updates.push(`smtp_password = $${paramIndex++}`);
    values.push(encryptCredential(row.smtp_password));
  }

  if (updates.length === 0) {
    return;
  }

  values.push(accountId, tenantId);
  await query(
    `UPDATE mail_accounts
     SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
     WHERE id = $${paramIndex++} AND tenant_id = $${paramIndex}`,
    values
  );
}

export function normalizeProvider(provider: unknown): 'imap' | 'gmail' | 'outlook' {
  const value = String(provider || 'imap').toLowerCase();
  if (value === 'gmail' || value === 'google') return 'gmail';
  if (value === 'outlook' || value === 'microsoft') return 'outlook';
  return 'imap';
}

export function emailsMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
