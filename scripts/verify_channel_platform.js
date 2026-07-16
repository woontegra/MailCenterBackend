/**
 * Local verification for channel platform foundation.
 * Read/write only temporary verify rows, then cleans up.
 */
require('dotenv').config();
const { Client } = require('pg');
const {
  canActivateChannel,
  validateTemplateSubject,
} = require('../dist/utils/channelPlatform.js');

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
        ? { rejectUnauthorized: false }
        : false,
  });
  await client.connect();

  const tables = await client.query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('brands', 'channel_connections', 'sender_identities')
    ORDER BY 1
  `);
  console.log('tables:', tables.rows.map((r) => r.tablename).join(', ') || '(none)');

  const cols = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'templates'
      AND column_name IN (
        'brand_id', 'channel_type', 'sender_identity_id',
        'subject', 'plain_text_content', 'variables', 'is_active', 'tenant_id'
      )
    ORDER BY 1
  `);
  console.log('template_cols:', cols.rows.map((r) => r.column_name).join(', '));

  console.log(
    'sms_active_block:',
    canActivateChannel({ channelType: 'SMS', encryptedCredentials: null }).ok === false
      ? 'OK'
      : 'FAIL'
  );
  console.log(
    'wa_active_block:',
    canActivateChannel({ channelType: 'WHATSAPP', encryptedCredentials: null }).ok === false
      ? 'OK'
      : 'FAIL'
  );
  console.log(
    'sms_subject_block:',
    validateTemplateSubject('SMS', 'Konu').ok === false ? 'OK' : 'FAIL'
  );
  console.log(
    'email_subject_ok:',
    validateTemplateSubject('EMAIL', 'Konu').ok ? 'OK' : 'FAIL'
  );

  const tenants = await client.query('SELECT id FROM tenants ORDER BY id ASC LIMIT 2');
  if (tenants.rows.length === 0) {
    console.log('tenant_isolation: SKIPPED_NO_TENANTS');
    await client.end();
    console.log('VERIFY_DONE');
    return;
  }

  const tenantA = tenants.rows[0].id;
  const brand = await client.query(
    `INSERT INTO brands (tenant_id, name, slug, is_active)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (tenant_id, slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [tenantA, 'Verify Brand A', `verify-brand-a-${tenantA}`]
  );
  const brandId = brand.rows[0].id;

  if (tenants.rows.length >= 2) {
    const cross = await client.query(
      'SELECT id FROM brands WHERE id = $1 AND tenant_id = $2',
      [brandId, tenants.rows[1].id]
    );
    console.log('tenant_isolation:', cross.rows.length === 0 ? 'OK' : 'FAIL');
  } else {
    console.log('tenant_isolation: SKIPPED_ONE_TENANT (scoped queries use tenant_id)');
  }

  const conn = await client.query(
    `INSERT INTO channel_connections
       (tenant_id, brand_id, channel_type, provider, display_name, status)
     VALUES ($1, $2, 'SMS', 'none', 'Verify SMS', 'NOT_CONFIGURED')
     RETURNING id`,
    [tenantA, brandId]
  );

  try {
    await client.query('DELETE FROM brands WHERE id = $1', [brandId]);
    console.log('brand_delete_restrict: FAIL');
  } catch (e) {
    console.log(
      'brand_delete_restrict:',
      e.code === '23503' || e.code === '23001' ? 'OK' : e.code || e.message
    );
  }

  await client.query('DELETE FROM channel_connections WHERE id = $1', [conn.rows[0].id]);
  await client.query('DELETE FROM brands WHERE id = $1', [brandId]);
  console.log('cleanup: OK');

  await client.end();
  console.log('VERIFY_DONE');
}

main().catch((e) => {
  console.error('VERIFY_FAIL', e.message);
  process.exit(1);
});
