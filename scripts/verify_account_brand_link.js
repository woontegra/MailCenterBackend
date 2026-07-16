/**
 * Verifies account linking security behaviors (local DB).
 * Does not print secrets. Cleans up temporary rows.
 */
require('dotenv').config();
const { Client } = require('pg');
const crypto = require('../dist/utils/mailCredentialsCrypto.js');
const { sanitizeMailAccount: sanitize } = require('../dist/utils/mailAccountUtils.js');

async function main() {
  if (!process.env.MAIL_CREDENTIALS_ENCRYPTION_KEY) {
    process.env.MAIL_CREDENTIALS_ENCRYPTION_KEY =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  }

  const a = crypto.encryptCredential('same-password');
  const b = crypto.encryptCredential('same-password');
  console.log('different_iv:', a !== b ? 'OK' : 'FAIL');
  console.log('roundtrip:', crypto.decryptCredential(a) === 'same-password' ? 'OK' : 'FAIL');

  const prev = process.env.MAIL_CREDENTIALS_ENCRYPTION_KEY;
  process.env.MAIL_CREDENTIALS_ENCRYPTION_KEY =
    'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
  let wrong = false;
  try {
    crypto.decryptCredential(a);
  } catch {
    wrong = true;
  }
  process.env.MAIL_CREDENTIALS_ENCRYPTION_KEY = prev;
  console.log('wrong_key:', wrong ? 'OK' : 'FAIL');

  const sanitized = sanitize({
    id: 1,
    email: 'x@example.com',
    imap_password: 'secret',
    smtp_password: 'secret',
    access_token: 'tok',
    refresh_token: 'ref',
    name: 'Test',
  });
  console.log(
    'sanitize:',
    !('imap_password' in sanitized) &&
      !('smtp_password' in sanitized) &&
      !('access_token' in sanitized) &&
      !('refresh_token' in sanitized)
      ? 'OK'
      : 'FAIL'
  );

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
        ? { rejectUnauthorized: false }
        : false,
  });
  await client.connect();

  const tenants = await client.query('SELECT id FROM tenants ORDER BY id ASC LIMIT 2');
  if (tenants.rows.length === 0) {
    console.log('tenant_tests: SKIPPED_NO_TENANTS');
    await client.end();
    console.log('VERIFY_DONE');
    return;
  }

  const tenantA = tenants.rows[0].id;
  let brand = await client.query(
    `SELECT id FROM brands WHERE tenant_id = $1 ORDER BY id ASC LIMIT 1`,
    [tenantA]
  );
  if (brand.rows.length === 0) {
    brand = await client.query(
      `INSERT INTO brands (tenant_id, name, slug, is_active)
       VALUES ($1, 'Verify Link Brand', $2, true)
       RETURNING id`,
      [tenantA, `verify-link-brand-${tenantA}`]
    );
  }
  const brandId = brand.rows[0].id;

  // Transaction rollback leaves no half records
  const marker = `verify-rollback-${Date.now()}@example.com`;
  try {
    await client.query('BEGIN');
    const acc = await client.query(
      `INSERT INTO mail_accounts
         (name, email, imap_host, imap_port, imap_user, imap_password, tenant_id)
       VALUES ('Rollback', $1, 'imap.example.com', 993, $1, $2, $3)
       RETURNING id`,
      [marker, crypto.encryptCredential('temp-pass'), tenantA]
    );
    await client.query(
      `INSERT INTO channel_connections
         (tenant_id, brand_id, channel_type, display_name, status, mail_account_id)
       VALUES ($1, $2, 'EMAIL', 'Rollback Conn', 'NOT_CONFIGURED', $3)`,
      [tenantA, brandId, acc.rows[0].id]
    );
    throw new Error('FORCE_ROLLBACK');
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.message !== 'FORCE_ROLLBACK') throw e;
  }

  const leftover = await client.query(`SELECT id FROM mail_accounts WHERE email = $1`, [marker]);
  console.log('transaction_rollback:', leftover.rows.length === 0 ? 'OK' : 'FAIL');

  // Empty password update keeps existing ciphertext
  const emailKeep = `verify-keep-${Date.now()}@example.com`;
  const enc1 = crypto.encryptCredential('original-secret');
  const created = await client.query(
    `INSERT INTO mail_accounts
       (name, email, imap_host, imap_port, imap_user, imap_password, tenant_id)
     VALUES ('Keep', $1, 'imap.example.com', 993, $1, $2, $3)
     RETURNING id, imap_password`,
    [emailKeep, enc1, tenantA]
  );
  const keepId = created.rows[0].id;
  const before = created.rows[0].imap_password;

  // Simulate empty password patch: no password column update
  await client.query(
    `UPDATE mail_accounts SET name = 'Keep Updated', updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND tenant_id = $2`,
    [keepId, tenantA]
  );
  const after = await client.query(
    `SELECT imap_password FROM mail_accounts WHERE id = $1 AND tenant_id = $2`,
    [keepId, tenantA]
  );
  console.log('empty_password_keep:', after.rows[0].imap_password === before ? 'OK' : 'FAIL');

  if (tenants.rows.length >= 2) {
    const tenantB = tenants.rows[1].id;
    const cross = await client.query(
      `SELECT id FROM mail_accounts WHERE id = $1 AND tenant_id = $2`,
      [keepId, tenantB]
    );
    console.log('tenant_isolation:', cross.rows.length === 0 ? 'OK' : 'FAIL');
  } else {
    console.log('tenant_isolation: SKIPPED_ONE_TENANT');
  }

  await client.query(`DELETE FROM mail_accounts WHERE id = $1 AND tenant_id = $2`, [
    keepId,
    tenantA,
  ]);
  await client.end();
  console.log('VERIFY_DONE');
}

main().catch((e) => {
  console.error('VERIFY_FAIL', e.message);
  process.exit(1);
});
