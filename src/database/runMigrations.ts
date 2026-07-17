import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

if (!process.env.DATABASE_URL) {
  throw new Error(
    'Configuration error: DATABASE_URL is required to run migrations.'
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
});

const migrations = [
  'schema.sql',
  'schema_upgrade.sql',
  'add_company_name.sql',
  'mail_operations_upgrade.sql',
  'saas_upgrade.sql',
  'oauth_storage_upgrade.sql',
  'enterprise_upgrade.sql',
  'super_admin_upgrade.sql',
  'user_profile_upgrade.sql',
  'channel_platform_upgrade.sql',
  'mail_account_brand_link_upgrade.sql',
  'compose_drafts_upgrade.sql',
  'domain_deliverability_upgrade.sql',
  'outbound_messages_upgrade.sql',
  'contacts_upgrade.sql',
  'whatsapp_upgrade.sql',
  'unified_inbox_upgrade.sql',
  'team_permissions_upgrade.sql',
  'saas_platform_upgrade.sql',
  'automation_center_upgrade.sql',
  'imap_idle_upgrade.sql',
  'email_template_blocks_upgrade.sql',
  'email_campaigns_upgrade.sql',
  'campaign_recipient_management_upgrade.sql',
  'template_media_assets_upgrade.sql',
  'mail_html_body_upgrade.sql',
];

async function runMigrations() {
  console.log('🚀 Starting database migrations...\n');

  try {
    await pool.query('SELECT NOW()');
    console.log('✓ Database connected\n');

    for (const migration of migrations) {
      const filePath = path.join(__dirname, migration);
      
      if (!fs.existsSync(filePath)) {
        console.log(`⚠️  Skipping ${migration} (file not found)`);
        continue;
      }

      console.log(`📝 Running migration: ${migration}`);
      
      const sql = fs.readFileSync(filePath, 'utf-8');
      
      await pool.query(sql);
      
      console.log(`✓ Completed: ${migration}\n`);
    }

    console.log('🎉 All migrations completed successfully!');
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigrations();
