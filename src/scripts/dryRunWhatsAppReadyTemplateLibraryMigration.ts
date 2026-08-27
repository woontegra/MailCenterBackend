/**
 * Read-only dry-run checks for whatsapp_ready_template_library_upgrade.sql
 * Does NOT apply the migration.
 * Run: npx ts-node src/scripts/dryRunWhatsAppReadyTemplateLibraryMigration.ts
 */
import * as dotenv from 'dotenv';
import { Client } from 'pg';

dotenv.config();

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL required');
  }
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : { rejectUnauthorized: false },
  });
  await client.connect();

  const q = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;

  const cols = await q(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'templates'
      AND column_name IN (
        'library_key', 'provider_rejection_reason',
        'provider_approval_status', 'provider_waba_id', 'channel_connection_id'
      )
    ORDER BY column_name
  `);

  const checks = await q(`
    SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = 'public.templates'::regclass
      AND contype = 'c'
      AND conname LIKE '%provider_approval%'
  `);

  const indexes = await q(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'templates'
      AND (indexname LIKE '%library%' OR indexdef ILIKE '%library_key%' OR indexname LIKE '%waba%')
    ORDER BY indexname
  `);

  const statuses = await q(`
    SELECT COALESCE(provider_approval_status, '(null)') AS status, COUNT(*)::int AS n
    FROM templates
    GROUP BY 1
    ORDER BY 2 DESC
  `);

  const conflictingStatuses = await q(`
    SELECT id, tenant_id, channel_type, provider_approval_status
    FROM templates
    WHERE provider_approval_status IS NOT NULL
      AND provider_approval_status NOT IN ('UNKNOWN', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED')
    ORDER BY id
    LIMIT 50
  `);

  const hasLibraryKey = cols.some((r: any) => r.column_name === 'library_key');

  let libraryKeyDuplicates: any[] = [];
  if (hasLibraryKey) {
    libraryKeyDuplicates = await q(`
      SELECT tenant_id, provider_waba_id, library_key, COUNT(*)::int AS n,
             array_agg(id ORDER BY id) AS ids
      FROM templates
      WHERE library_key IS NOT NULL AND provider_waba_id IS NOT NULL
      GROUP BY 1, 2, 3
      HAVING COUNT(*) > 1
      ORDER BY n DESC
      LIMIT 50
    `);
  }

  // Rows that would collide if the unique index is created after library_key is populated
  // for the same catalog provider names (not yet library_key — informational only).
  const sameNameWabaDuplicates = await q(`
    SELECT tenant_id, provider_waba_id, provider_template_name, COUNT(*)::int AS n,
           array_agg(id ORDER BY id) AS ids
    FROM templates
    WHERE channel_type = 'WHATSAPP'
      AND provider_waba_id IS NOT NULL
      AND provider_template_name IS NOT NULL
    GROUP BY 1, 2, 3
    HAVING COUNT(*) > 1
    ORDER BY n DESC
    LIMIT 20
  `);

  const totals = await q(`SELECT COUNT(*)::int AS templates FROM templates`);

  const allowedForCheck = new Set(['UNKNOWN', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', '(null)']);
  const statusOk = statuses.every((s: any) => allowedForCheck.has(String(s.status)));
  const uniqueWouldFail = hasLibraryKey && libraryKeyDuplicates.length > 0;

  const report = {
    mode: 'dry-run-read-only',
    applied: false,
    templatesTotal: totals[0].templates,
    columns: cols,
    library_key_exists: hasLibraryKey,
    provider_rejection_reason_exists: cols.some((r: any) => r.column_name === 'provider_rejection_reason'),
    approvalChecks: checks,
    relatedIndexes: indexes,
    statusDistribution: statuses,
    conflictingStatuses,
    checkConstraintSafe: statusOk && conflictingStatuses.length === 0,
    libraryKeyDuplicates,
    uniqueIndexWouldFailNow: uniqueWouldFail,
    sameNameWabaDuplicates,
    blockers: [
      ...(!statusOk || conflictingStatuses.length
        ? ['CHECK constraint would fail: unexpected provider_approval_status values exist']
        : []),
      ...(uniqueWouldFail
        ? ['UNIQUE index idx_templates_library_key_waba would fail: duplicate (tenant_id, provider_waba_id, library_key) rows']
        : []),
    ],
  };

  console.log(JSON.stringify(report, null, 2));
  await client.end();

  if (report.blockers.length) {
    console.error('\nBLOCKERS present — do not apply migration until resolved.');
    process.exit(2);
  }
  console.error('\nNo blockers — migration appears safe to apply.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
