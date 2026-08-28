/** READ-ONLY: Bilirkişi ready template submit diagnosis. */
import dotenv from 'dotenv';
import { Client } from 'pg';

dotenv.config();

async function main() {
  const c = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? undefined : { rejectUnauthorized: false },
  });
  await c.connect();

  const brands = await c.query(
    `SELECT id, name, tenant_id FROM brands
     WHERE name ILIKE '%bilirki%' OR name ILIKE '%bilirkişi%' OR name ILIKE '%bilirkisi%'
     ORDER BY id`
  );

  const woontegra = await c.query(
    `SELECT id, name FROM brands WHERE tenant_id = 5 AND name ILIKE '%woontegra%' ORDER BY id LIMIT 3`
  );

  const conn12 = await c.query(
    `SELECT id, tenant_id, brand_id, status, settings FROM channel_connections WHERE id = 12`
  );
  const settings = (conn12.rows[0]?.settings || {}) as Record<string, string>;
  const wabaId = settings.waba_id || settings.wabaId;

  let bilirkisiId = brands.rows.find((b) => b.tenant_id === 5)?.id;

  const share = bilirkisiId
    ? await c.query(
        `SELECT * FROM channel_connection_brand_shares
         WHERE channel_connection_id = 12 AND brand_id = $1`,
        [bilirkisiId]
      )
    : { rows: [] };

  const senders = bilirkisiId
    ? await c.query(
        `SELECT id, brand_id, channel_connection_id, is_active, is_verified, display_name
         FROM sender_identities
         WHERE channel_connection_id = 12 AND brand_id = $1`,
        [bilirkisiId]
      )
    : { rows: [] };

  const templatesWaba = await c.query(
    `SELECT id, brand_id, library_key, provider_template_name, provider_template_language,
            provider_waba_id, provider_approval_status, channel_connection_id, created_at
     FROM templates
     WHERE tenant_id = 5 AND channel_type = 'WHATSAPP'
       AND (
         provider_waba_id = $1
         OR channel_connection_id = 12
         OR provider_waba_id IS NULL
       )
     ORDER BY brand_id, library_key NULLS LAST, id`,
    [wabaId]
  );

  const libraryTemplates = await c.query(
    `SELECT id, brand_id, library_key, provider_template_name, provider_approval_status
     FROM templates
     WHERE tenant_id = 5 AND channel_type = 'WHATSAPP' AND library_key IS NOT NULL
     ORDER BY library_key, brand_id`
  );

  console.log(
    JSON.stringify(
      {
        bilirkisi_brands: brands.rows,
        bilirkisi_id_used: bilirkisiId ?? null,
        woontegra_brands: woontegra.rows,
        connection_12: conn12.rows[0]
          ? {
              id: conn12.rows[0].id,
              tenant_id: conn12.rows[0].tenant_id,
              brand_id: conn12.rows[0].brand_id,
              status: conn12.rows[0].status,
              waba_id: wabaId,
              phone_number_id: settings.phone_number_id,
              display_phone: settings.business_phone_number || settings.business_phone,
            }
          : null,
        share_row: share.rows[0] || null,
        bilirkisi_sender: senders.rows[0] || null,
        templates_on_waba: templatesWaba.rows,
        library_key_templates: libraryTemplates.rows,
      },
      null,
      2
    )
  );

  const idx = await c.query(
    `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'templates' AND indexname LIKE '%library%'`
  );
  const b7 = await c.query(
    `SELECT id, library_key, provider_template_name, brand_id FROM templates
     WHERE tenant_id = 5 AND brand_id = 7 AND channel_type = 'WHATSAPP'`
  );

  // Simulate submitReadyTemplate branch conditions for payment_due_reminder
  const catalogKey = 'payment_due_reminder';
  const catalogProvider = 'mc_odeme_son_tarih';
  const brandId = bilirkisiId;
  const existingForBrand =
    (
      await c.query(
        `SELECT id FROM templates WHERE tenant_id=5 AND channel_type='WHATSAPP'
         AND library_key=$1 AND provider_waba_id=$2 AND brand_id=$3 LIMIT 1`,
        [catalogKey, wabaId, brandId]
      )
    ).rows[0] || null;
  const existingOnWaba =
    (
      await c.query(
        `SELECT id, brand_id, library_key FROM templates WHERE tenant_id=5 AND channel_type='WHATSAPP'
         AND library_key=$1 AND provider_waba_id=$2 LIMIT 1`,
        [catalogKey, wabaId]
      )
    ).rows[0] || null;

  console.log(
    JSON.stringify(
      {
        library_indexes: idx.rows,
        bilirkisi_whatsapp_templates: b7.rows,
        simulate_payment_due_reminder: {
          existingForBrand,
          existingOnWaba,
          clone_branch_would_run: Boolean(!existingForBrand && existingOnWaba),
          unique_index_blocks_clone:
            Boolean(existingOnWaba) &&
            existingOnWaba.brand_id !== brandId &&
            Boolean(
              idx.rows.some((r: { indexname: string }) => r.indexname === 'idx_templates_library_key_waba')
            ),
        },
      },
      null,
      2
    )
  );

  await c.end();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
