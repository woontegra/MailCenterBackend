/**
 * Apply ONLY whatsapp_connection_brand_share_upgrade.sql to live DB.
 * Run: npx ts-node src/scripts/applyBrandShareMigrationOnly.ts
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { Client } from 'pg';

dotenv.config();

const MIGRATION = 'whatsapp_connection_brand_share_upgrade.sql';

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');

  const filePath = path.join(__dirname, '..', 'database', MIGRATION);
  if (!fs.existsSync(filePath)) throw new Error(`Migration file not found: ${filePath}`);

  const sql = fs.readFileSync(filePath, 'utf8');

  const c = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost')
      ? undefined
      : { rejectUnauthorized: false },
  });
  await c.connect();

  console.log(`Applying: ${MIGRATION}`);
  await c.query(sql);
  console.log('Migration applied successfully.');
  await c.end();
}

main().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});
