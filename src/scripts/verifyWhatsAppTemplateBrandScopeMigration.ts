/**
 * Post-migration verify + transactional INSERT probe (ROLLBACK, no persistent rows).
 * Run: npx ts-node src/scripts/verifyWhatsAppTemplateBrandScopeMigration.ts
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

  const idx = await c.query(
    `SELECT indexname, indexdef FROM pg_indexes WHERE indexname = 'idx_templates_library_key_waba'`
  );

  const t29 = await c.query(`SELECT * FROM templates WHERE id = 29`);
  const woontegraCounts = await c.query(
    `SELECT provider_approval_status, COUNT(*)::int AS n
     FROM templates WHERE tenant_id = 5 AND brand_id = 6 AND channel_type = 'WHATSAPP'
     GROUP BY provider_approval_status ORDER BY provider_approval_status`
  );
  const b7 = await c.query(
    `SELECT COUNT(*)::int AS n FROM templates WHERE tenant_id = 5 AND brand_id = 7`
  );
  const conn = await c.query(`SELECT id, brand_id, status FROM channel_connections WHERE id = 12`);
  const senders = await c.query(
    `SELECT id, brand_id, is_active FROM sender_identities WHERE channel_connection_id = 12 ORDER BY id`
  );

  let insertCrossBrandOk = false;
  let insertSameBrandBlocked = false;
  let insertErrorSameBrand: string | null = null;

  try {
    await c.query('BEGIN');

    const source = t29.rows[0];
    if (!source) throw new Error('template 29 missing');

    await c.query(
      `INSERT INTO templates
        (name, content, tenant_id, created_by, is_shared, brand_id, channel_type,
         plain_text_content, variables, is_active, is_draft, template_kind,
         provider_template_name, provider_template_language, provider_approval_status,
         provider_template_components, provider_waba_id, channel_connection_id, library_key)
       VALUES ($1,$2,$3,$4,true,$5,'WHATSAPP',$2,'[]'::jsonb,true,false,'INDIVIDUAL',
         $6,$7,$8,$9::jsonb,$10,$11,$12)`,
      [
        source.name,
        source.plain_text_content || source.content,
        source.tenant_id,
        source.created_by,
        7,
        source.provider_template_name,
        source.provider_template_language,
        source.provider_approval_status,
        JSON.stringify(source.provider_template_components || {}),
        source.provider_waba_id,
        source.channel_connection_id,
        source.library_key,
      ]
    );
    insertCrossBrandOk = true;

    try {
      await c.query(
        `INSERT INTO templates
          (name, content, tenant_id, created_by, is_shared, brand_id, channel_type,
           plain_text_content, variables, is_active, is_draft, template_kind,
           provider_template_name, provider_template_language, provider_approval_status,
           provider_template_components, provider_waba_id, channel_connection_id, library_key)
         VALUES ($1,$2,$3,$4,true,$5,'WHATSAPP',$2,'[]'::jsonb,true,false,'INDIVIDUAL',
           $6,$7,$8,$9::jsonb,$10,$11,$12)`,
        [
          source.name + ' dup',
          source.plain_text_content || source.content,
          source.tenant_id,
          source.created_by,
          7,
          source.provider_template_name,
          source.provider_template_language,
          source.provider_approval_status,
          JSON.stringify(source.provider_template_components || {}),
          source.provider_waba_id,
          source.channel_connection_id,
          source.library_key,
        ]
      );
    } catch (e: any) {
      insertSameBrandBlocked = e.code === '23505';
      insertErrorSameBrand = e.message;
    }

    await c.query('ROLLBACK');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  }

  const b7After = await c.query(
    `SELECT COUNT(*)::int AS n FROM templates WHERE tenant_id = 5 AND brand_id = 7`
  );

  console.log(
    JSON.stringify(
      {
        index: idx.rows[0] || null,
        template_29_unchanged: Boolean(t29.rows[0]),
        template_29_snapshot: t29.rows[0]
          ? {
              id: t29.rows[0].id,
              brand_id: t29.rows[0].brand_id,
              library_key: t29.rows[0].library_key,
              provider_waba_id: t29.rows[0].provider_waba_id,
              provider_approval_status: t29.rows[0].provider_approval_status,
            }
          : null,
        woontegra_whatsapp_status_counts: woontegraCounts.rows,
        bilirkisi_template_count: b7.rows[0].n,
        bilirkisi_template_count_after_rollback: b7After.rows[0].n,
        connection_12: conn.rows[0],
        senders_conn_12: senders.rows,
        tx_insert_cross_brand_ok: insertCrossBrandOk,
        tx_insert_same_brand_blocked: insertSameBrandBlocked,
        tx_same_brand_error_snippet: insertErrorSameBrand
          ? String(insertErrorSameBrand).slice(0, 200)
          : null,
      },
      null,
      2
    )
  );

  await c.end();

  const indexOk = Boolean(
    idx.rows[0]?.indexdef?.includes('brand_id') &&
      idx.rows[0]?.indexdef?.includes('library_key IS NOT NULL') &&
      idx.rows[0]?.indexdef?.includes('provider_waba_id IS NOT NULL')
  );
  if (!indexOk || !insertCrossBrandOk || !insertSameBrandBlocked || b7After.rows[0].n !== 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Verify failed:', e.message);
  process.exit(1);
});
