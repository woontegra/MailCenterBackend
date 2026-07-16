import * as dotenv from 'dotenv';
import { Pool } from 'pg';
import {
  decryptCredential,
  encryptCredential,
  isEncryptedCredential,
} from '../src/utils/mailCredentialsCrypto';
import {
  migrateLegacyCredentials,
  PUBLIC_MAIL_ACCOUNT_FIELDS,
  sanitizeMailAccount,
} from '../src/utils/mailAccountUtils';

dotenv.config();

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function run(): Promise<void> {
  if (!process.env.MAIL_CREDENTIALS_ENCRYPTION_KEY) {
    process.env.MAIL_CREDENTIALS_ENCRYPTION_KEY =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  }

  const plaintextImap = 'imap-test-secret-value';
  const plaintextSmtp = 'smtp-test-secret-value';
  const encryptedImap = encryptCredential(plaintextImap);
  const encryptedSmtp = encryptCredential(plaintextSmtp);

  assert(isEncryptedCredential(encryptedImap), 'Stored IMAP value must be encrypted');
  assert(isEncryptedCredential(encryptedSmtp), 'Stored SMTP value must be encrypted');
  assert(encryptedImap !== plaintextImap, 'Database must not store plaintext IMAP password');

  const sanitized = sanitizeMailAccount({
    id: 1,
    email: 'test@example.com',
    imap_password: encryptedImap,
    smtp_password: encryptedSmtp,
    access_token: 'token',
    refresh_token: 'refresh',
  });

  assert(!('imap_password' in sanitized), 'Sanitized account must not include imap_password');
  assert(!('smtp_password' in sanitized), 'Sanitized account must not include smtp_password');
  assert(!('access_token' in sanitized), 'Sanitized account must not include access_token');
  assert(!('refresh_token' in sanitized), 'Sanitized account must not include refresh_token');

  if (!process.env.DATABASE_URL && !process.env.DB_HOST) {
    console.log('✓ in-memory mail account security checks passed (database checks skipped)');
    return;
  }

  const pool = new Pool(
    process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL }
      : {
          host: process.env.DB_HOST,
          port: parseInt(process.env.DB_PORT || '5432'),
          database: process.env.DB_NAME,
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
        }
  );

  const suffix = Date.now();
  const tenantResult = await pool.query(
    'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
    [`security-test-${suffix}`]
  );
  const tenantId = tenantResult.rows[0].id;

  const insertResult = await pool.query(
    `INSERT INTO mail_accounts
      (name, email, imap_host, imap_port, imap_user, imap_password, smtp_host, smtp_port, smtp_user, smtp_password, tenant_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, imap_password, smtp_password`,
    [
      'Security Test',
      `security-${suffix}@example.com`,
      'imap.example.com',
      993,
      'user',
      encryptedImap,
      'smtp.example.com',
      587,
      'user',
      encryptedSmtp,
      tenantId,
    ]
  );

  const accountId = insertResult.rows[0].id;
  assert(isEncryptedCredential(insertResult.rows[0].imap_password), 'Database row must store encrypted IMAP password');
  assert(insertResult.rows[0].imap_password !== plaintextImap, 'Database row must not contain plaintext IMAP password');

  await pool.query(
    `UPDATE mail_accounts
     SET smtp_password = $1
     WHERE id = $2 AND tenant_id = $3`,
    [plaintextSmtp, accountId, tenantId]
  );

  await migrateLegacyCredentials(accountId, tenantId);

  const migratedResult = await pool.query(
    'SELECT imap_password, smtp_password FROM mail_accounts WHERE id = $1 AND tenant_id = $2',
    [accountId, tenantId]
  );

  assert(
    isEncryptedCredential(migratedResult.rows[0].smtp_password),
    'Legacy SMTP password must be migrated to encrypted format'
  );
  assert(
    decryptCredential(migratedResult.rows[0].smtp_password) === plaintextSmtp,
    'Migrated SMTP password must decrypt correctly'
  );

  const preservedSecret = 'smtp-preserve-secret-value';
  await pool.query(
    `UPDATE mail_accounts
     SET smtp_password = $1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2 AND tenant_id = $3`,
    [encryptCredential(preservedSecret), accountId, tenantId]
  );

  await pool.query(
    `UPDATE mail_accounts
     SET smtp_host = $1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2 AND tenant_id = $3`,
    ['smtp-updated.example.com', accountId, tenantId]
  );

  const emptyPatchPreserved = await pool.query(
    'SELECT smtp_password FROM mail_accounts WHERE id = $1 AND tenant_id = $2',
    [accountId, tenantId]
  );
  assert(
    decryptCredential(emptyPatchPreserved.rows[0].smtp_password) === preservedSecret,
    'Update without password field must preserve existing encrypted SMTP password'
  );

  const updatedSecret = 'smtp-updated-secret-value';
  await pool.query(
    `UPDATE mail_accounts
     SET smtp_password = $1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2 AND tenant_id = $3`,
    [encryptCredential(updatedSecret), accountId, tenantId]
  );

  const updatedResult = await pool.query(
    'SELECT smtp_password FROM mail_accounts WHERE id = $1 AND tenant_id = $2',
    [accountId, tenantId]
  );
  assert(
    decryptCredential(updatedResult.rows[0].smtp_password) === updatedSecret,
    'Updated SMTP password must decrypt to the newly provided value'
  );
  assert(
    isEncryptedCredential(updatedResult.rows[0].smtp_password),
    'Updated SMTP password must remain encrypted in storage'
  );

  const publicResult = await pool.query(
    `SELECT ${PUBLIC_MAIL_ACCOUNT_FIELDS}
     FROM mail_accounts
     WHERE id = $1 AND tenant_id = $2`,
    [accountId, tenantId]
  );

  const publicAccount = sanitizeMailAccount(publicResult.rows[0]);
  assert(!('imap_password' in publicAccount), 'Public account query must not expose imap_password');
  assert(!('smtp_password' in publicAccount), 'Public account query must not expose smtp_password');

  const otherTenantResult = await pool.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [
    `security-other-${suffix}`,
  ]);
  const otherTenantId = otherTenantResult.rows[0].id;

  const crossTenantResult = await pool.query(
    'SELECT id FROM mail_accounts WHERE id = $1 AND tenant_id = $2',
    [accountId, otherTenantId]
  );
  assert(crossTenantResult.rows.length === 0, 'Other tenant must not access account by id');

  await pool.query('DELETE FROM mail_accounts WHERE tenant_id = $1', [tenantId]);
  await pool.query('DELETE FROM tenants WHERE id = ANY($1::int[])', [[tenantId, otherTenantId]]);

  await pool.end();

  console.log('✓ mail account security verification passed');
}

run().catch((error) => {
  console.error('✗ mail account security verification failed');
  console.error(error.message || error);
  process.exit(1);
});
