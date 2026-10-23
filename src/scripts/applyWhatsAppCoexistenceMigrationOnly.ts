/**
 * Apply ONLY whatsapp_coexistence_upgrade.sql (additive, idempotent).
 * Requires explicit confirmation so it is never run by accident against production.
 * Run: CONFIRM_WHATSAPP_COEXISTENCE_MIGRATION=yes EXPECTED_DATABASE_NAME=<db> EXPECTED_SYSTEM_IDENTIFIER=<id> \
 *        npx ts-node src/scripts/applyWhatsAppCoexistenceMigrationOnly.ts
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { Client } from 'pg';

dotenv.config();

const MIGRATION = 'whatsapp_coexistence_upgrade.sql';

async function main() {
  if (process.env.CONFIRM_WHATSAPP_COEXISTENCE_MIGRATION !== 'yes') {
    throw new Error('Set CONFIRM_WHATSAPP_COEXISTENCE_MIGRATION=yes to apply this migration');
  }
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

  console.log(`Target database host: ${new URL(process.env.DATABASE_URL).hostname}`);

  // Same connection as the migration: abort before any write if the target is not the expected cluster.
  const expectedDb = String(process.env.EXPECTED_DATABASE_NAME || '').trim();
  const expectedSystemId = String(process.env.EXPECTED_SYSTEM_IDENTIFIER || '').trim();
  if (!expectedDb || !expectedSystemId) {
    await c.end();
    throw new Error('Set EXPECTED_DATABASE_NAME and EXPECTED_SYSTEM_IDENTIFIER to confirm the target');
  }
  const identity = await c.query(
    `SELECT current_database() AS db, (SELECT system_identifier::text FROM pg_control_system()) AS system_id`
  );
  const { db, system_id: systemId } = identity.rows[0];
  console.log(`Target database: ${db}, system identifier: ${systemId}`);
  if (db !== expectedDb || systemId !== expectedSystemId) {
    await c.end();
    throw new Error('Target database does not match the expected database; nothing was written');
  }

  console.log(`Applying: ${MIGRATION}`);
  await c.query('BEGIN');
  try {
    await c.query("SET LOCAL lock_timeout = '5s'");
    await c.query("SET LOCAL statement_timeout = '60s'");
    await c.query(sql);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  }
  console.log('Migration applied successfully.');
  await c.end();
}

main().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});
