import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ENCRYPTION_VERSION = 'v1';
const ENCRYPTION_PREFIX = `enc:${ENCRYPTION_VERSION}:`;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export function isEncryptedCredential(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(ENCRYPTION_PREFIX);
}

export function isLegacyPlaintextCredential(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.length > 0 && !isEncryptedCredential(value);
}

export function assertMailCredentialsEncryptionConfigured(): void {
  getEncryptionKey();
}

function getEncryptionKey(): Buffer {
  const raw = process.env.MAIL_CREDENTIALS_ENCRYPTION_KEY?.trim();

  if (!raw) {
    throw new Error(
      'Configuration error: MAIL_CREDENTIALS_ENCRYPTION_KEY is required for mail credential encryption.'
    );
  }

  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  const base64Key = Buffer.from(raw, 'base64');
  if (base64Key.length === KEY_LENGTH) {
    return base64Key;
  }

  throw new Error(
    'Configuration error: MAIL_CREDENTIALS_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64-encoded 32 bytes).'
  );
}

export function encryptCredential(plaintext: string | null | undefined): string | null {
  if (plaintext === null || plaintext === undefined || plaintext === '') {
    return null;
  }

  assertMailCredentialsEncryptionConfigured();

  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, authTag, encrypted]).toString('base64');

  return `${ENCRYPTION_PREFIX}${payload}`;
}

export function decryptCredential(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined || stored === '') {
    return null;
  }

  if (isLegacyPlaintextCredential(stored)) {
    return stored;
  }

  assertMailCredentialsEncryptionConfigured();

  const key = getEncryptionKey();
  const payload = Buffer.from(stored.slice(ENCRYPTION_PREFIX.length), 'base64');

  if (payload.length <= IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Invalid encrypted credential format.');
  }

  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}
