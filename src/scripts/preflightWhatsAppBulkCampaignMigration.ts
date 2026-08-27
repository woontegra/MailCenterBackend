/**
 * Read-only preflight for whatsapp_bulk_campaigns_upgrade.sql
 * Run: npx ts-node src/scripts/preflightWhatsAppBulkCampaignMigration.ts
 */
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';

dotenv.config();

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
});

async function columnExists(table: string, column: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return r.rows.length > 0;
}

async function indexExists(name: string): Promise<boolean> {
  const r = await pool.query(`SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [
    name,
  ]);
  return r.rows.length > 0;
}

async function main() {
  console.log('Preflight: whatsapp_bulk_campaigns_upgrade.sql\n');

  const campaignCount = await pool.query(`SELECT COUNT(*)::int AS c FROM campaigns`);
  const recipientCount = await pool.query(`SELECT COUNT(*)::int AS c FROM campaign_recipients`);
  const emailCampaigns = await pool.query(`SELECT COUNT(*)::int AS c FROM campaigns`);
  const emailRecipientsMissing = await pool.query(
    `SELECT COUNT(*)::int AS c FROM campaign_recipients
     WHERE email IS NULL OR email_normalized IS NULL`
  );
  let phoneDupes = { rows: [] as any[] };
  if (await columnExists('campaign_recipients', 'phone_normalized')) {
    phoneDupes = await pool.query(
      `SELECT campaign_id, phone_normalized, COUNT(*)::int AS c
       FROM campaign_recipients
       WHERE phone_normalized IS NOT NULL
       GROUP BY campaign_id, phone_normalized
       HAVING COUNT(*) > 1
       LIMIT 5`
    );
  }

  console.log(`campaigns rows: ${campaignCount.rows[0].c}`);
  console.log(`campaign_recipients rows: ${recipientCount.rows[0].c}`);
  console.log(`email-like campaigns: ${emailCampaigns.rows[0].c}`);
  console.log(`recipients missing email: ${emailRecipientsMissing.rows[0].c}`);

  const issues: string[] = [];

  if (Number(emailRecipientsMissing.rows[0].c) > 0) {
    issues.push('Some campaign_recipients already have NULL email — review before migration');
  }

  if (phoneDupes.rows.length > 0) {
    issues.push(
      `Duplicate phone_normalized groups would block unique index (${phoneDupes.rows.length}+ sample shown)`
    );
    for (const row of phoneDupes.rows) {
      console.log(`  dup campaign=${row.campaign_id} phone=${row.phone_normalized} count=${row.c}`);
    }
  }

  const migrationPath = path.join(__dirname, '../database/whatsapp_bulk_campaigns_upgrade.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');
  if (!sql.includes('ADD COLUMN IF NOT EXISTS channel_type')) {
    issues.push('Migration file missing idempotent channel_type add');
  }
  if (!sql.includes('DEFAULT \'EMAIL\'')) {
    issues.push('Migration missing EMAIL default backfill for channel_type');
  }

  const already = {
    channel_type: await columnExists('campaigns', 'channel_type'),
    channel_connection_id: await columnExists('campaigns', 'channel_connection_id'),
    phone: await columnExists('campaign_recipients', 'phone'),
    phone_normalized: await columnExists('campaign_recipients', 'phone_normalized'),
    skip_reason: await columnExists('campaign_recipients', 'skip_reason'),
    uq_phone: await indexExists('uq_campaign_recipients_phone'),
  };

  console.log('\nCurrent schema snapshot:');
  console.log(JSON.stringify(already, null, 2));

  if (issues.length > 0) {
    console.error('\n❌ Preflight FAILED:');
    for (const i of issues) console.error(` - ${i}`);
    process.exit(1);
  }

  console.log('\n✓ Preflight passed — migration appears safe to apply');
  await pool.end();
}

main().catch(async (err) => {
  console.error('Preflight error:', err);
  await pool.end();
  process.exit(1);
});
