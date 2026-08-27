/**
 * Post-migration read-only schema verification.
 * Run: npx ts-node src/scripts/verifyWhatsAppBulkCampaignMigration.ts
 */
import * as dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config();

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
});

async function must(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const cols = await pool.query(
    `SELECT table_name, column_name, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (
         (table_name = 'campaigns' AND column_name IN ('channel_type', 'channel_connection_id'))
         OR (table_name = 'campaign_recipients' AND column_name IN ('phone', 'phone_normalized', 'skip_reason', 'email', 'email_normalized'))
       )
     ORDER BY table_name, column_name`
  );

  const idx = await pool.query(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'uq_campaign_recipients_phone'`
  );

  const emailNulls = await pool.query(
    `SELECT COUNT(*)::int AS c FROM campaign_recipients WHERE email IS NULL OR email_normalized IS NULL`
  );
  const campaigns = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE channel_type = 'EMAIL')::int AS email_type
     FROM campaigns`
  );

  console.log('Schema columns:');
  for (const row of cols.rows) {
    console.log(
      `  ${row.table_name}.${row.column_name} nullable=${row.is_nullable} default=${row.column_default || '—'}`
    );
  }
  console.log('\nUnique index:');
  console.log(idx.rows[0]?.indexdef || '(missing)');

  console.log('\nData checks:');
  console.log(`  campaigns total=${campaigns.rows[0].total} email_type=${campaigns.rows[0].email_type}`);
  console.log(`  recipients with null email=${emailNulls.rows[0].c}`);

  const names = new Set(cols.rows.map((r) => `${r.table_name}.${r.column_name}`));
  await must(names.has('campaigns.channel_type'), 'campaigns.channel_type missing');
  await must(names.has('campaigns.channel_connection_id'), 'campaigns.channel_connection_id missing');
  await must(names.has('campaign_recipients.phone'), 'campaign_recipients.phone missing');
  await must(names.has('campaign_recipients.phone_normalized'), 'campaign_recipients.phone_normalized missing');
  await must(names.has('campaign_recipients.skip_reason'), 'campaign_recipients.skip_reason missing');

  const emailCol = cols.rows.find((r) => r.table_name === 'campaign_recipients' && r.column_name === 'email');
  await must(emailCol?.is_nullable === 'YES', 'campaign_recipients.email should be nullable');

  await must(idx.rows.length === 1, 'uq_campaign_recipients_phone index missing');
  await must(String(idx.rows[0].indexdef).includes('phone_normalized'), 'unique index wrong columns');

  console.log('\n✓ Post-migration verification passed');
  await pool.end();
}

main().catch(async (err) => {
  console.error('✗ Verification failed:', err.message || err);
  await pool.end();
  process.exit(1);
});
