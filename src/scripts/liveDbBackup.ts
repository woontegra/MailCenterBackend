/**
 * Logical PostgreSQL backup when pg_dump is unavailable.
 * Run: npx ts-node src/scripts/liveDbBackup.ts
 */
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';

dotenv.config();

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const backupDir = path.join(__dirname, '../../backups');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
});

function esc(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (typeof value === 'object') return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  if (typeof value === 'number') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function backupTable(table: string, write: (line: string) => void) {
  const colsRes = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table]
  );
  const columns = colsRes.rows.map((r) => r.column_name);
  if (columns.length === 0) return 0;

  const batchSize = 500;
  let offset = 0;
  let total = 0;

  while (true) {
    const rows = await pool.query(
      `SELECT * FROM ${table} ORDER BY 1 LIMIT $1 OFFSET $2`,
      [batchSize, offset]
    );
    if (rows.rows.length === 0) break;

    for (const row of rows.rows) {
      const values = columns.map((c) => esc(row[c])).join(', ');
      write(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${values});`);
      total += 1;
    }
    offset += batchSize;
  }
  return total;
}

async function main() {
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filepath = path.join(backupDir, `live-backup-${timestamp}.sql`);
  const lines: string[] = [
    '-- MailCenter logical backup',
    `-- Created: ${new Date().toISOString()}`,
    'BEGIN;',
  ];

  const write = (line: string) => lines.push(line);

  const tablesRes = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  );
  const tables = tablesRes.rows.map((r) => r.tablename as string);

  let grandTotal = 0;
  for (const table of tables) {
    const count = await backupTable(table, write);
    grandTotal += count;
    console.log(`  ${table}: ${count} rows`);
  }

  lines.push('COMMIT;');
  fs.writeFileSync(filepath, lines.join('\n'), 'utf8');

  const stat = fs.statSync(filepath);
  if (stat.size < 1024) {
    throw new Error('Backup file too small — likely failed');
  }

  console.log(`\n✓ Backup written: ${filepath}`);
  console.log(`  Tables: ${tables.length}, Rows: ${grandTotal}, Size: ${stat.size} bytes`);
  await pool.end();
  return filepath;
}

main().catch(async (err) => {
  console.error('✗ Backup failed:', err.message || err);
  await pool.end();
  process.exit(1);
});
