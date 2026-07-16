import {
  decryptCredential,
  encryptCredential,
  isEncryptedCredential,
  isLegacyPlaintextCredential,
} from '../src/utils/mailCredentialsCrypto';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function run(): void {
  process.env.MAIL_CREDENTIALS_ENCRYPTION_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  const plaintext = 'test-mail-password-value';

  const encryptedA = encryptCredential(plaintext);
  const encryptedB = encryptCredential(plaintext);

  assert(typeof encryptedA === 'string' && encryptedA.startsWith('enc:v1:'), 'Encrypted value must use enc:v1 prefix');
  assert(encryptedA !== encryptedB, 'Same plaintext must produce different ciphertext due to random IV');
  assert(decryptCredential(encryptedA) === plaintext, 'Round-trip decrypt must match plaintext');
  assert(isLegacyPlaintextCredential(plaintext), 'Plaintext must be detected as legacy');
  assert(!isEncryptedCredential(plaintext), 'Plaintext must not look encrypted');
  assert(decryptCredential(plaintext) === plaintext, 'Legacy plaintext must pass through decrypt');

  const wrongKey = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
  process.env.MAIL_CREDENTIALS_ENCRYPTION_KEY = wrongKey;

  let wrongKeyFailed = false;
  try {
    decryptCredential(encryptedA!);
  } catch {
    wrongKeyFailed = true;
  }

  assert(wrongKeyFailed, 'Decrypt with wrong key must fail');

  console.log('✓ mail credentials crypto verification passed');
}

run();
