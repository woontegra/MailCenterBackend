/**
 * READ-ONLY preflight for whatsapp_template_brand_scope_upgrade.sql
 * Run: npx ts-node src/scripts/preflightWhatsAppTemplateBrandScope.ts
 */
import dotenv from 'dotenv';
import { Client } from 'pg';

dotenv.config();

async function main() {
  const c = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? undefined : { rejectUnauthorized: false },
  });
  await c.connect();

  const uniques = await c.query(
    `SELECT c.conname, pg_get_constraintdef(c.oid) AS def
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'templates' AND c.contype = 'u'
     ORDER BY c.conname`
  );

  const indexes = await c.query(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE tablename = 'templates' AND indexdef ILIKE '%UNIQUE%'
     ORDER BY indexname`
  );

  const dups = await c.query(
    `SELECT tenant_id, brand_id, provider_waba_id, library_key, COUNT(*)::int AS n,
            array_agg(id ORDER BY id) AS ids
     FROM templates
     WHERE library_key IS NOT NULL AND provider_waba_id IS NOT NULL
     GROUP BY tenant_id, brand_id, provider_waba_id, library_key
     HAVING COUNT(*) > 1
     ORDER BY COUNT(*) DESC`
  );

  const t29 = await c.query(
    `SELECT id, tenant_id, brand_id, library_key, provider_template_name, provider_waba_id,
            provider_approval_status, channel_connection_id
     FROM templates WHERE id = 29`
  );

  const b7 = await c.query(
    `SELECT id, library_key FROM templates
     WHERE tenant_id = 5 AND brand_id = 7 AND library_key IS NOT NULL`
  );

  const currentIdx = await c.query(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE indexname = 'idx_templates_library_key_waba'`
  );

  const ok = dups.rows.length === 0;

  console.log(
    JSON.stringify(
      {
        preflight_ok: ok,
        unique_constraints: uniques.rows,
        unique_indexes: indexes.rows,
        duplicate_groups_new_scope: dups.rows,
        template_29: t29.rows[0] || null,
        bilirkisi_library_rows: b7.rows,
        current_idx_templates_library_key_waba: currentIdx.rows[0] || null,
      },
      null,
      2
    )
  );

  await c.end();
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
