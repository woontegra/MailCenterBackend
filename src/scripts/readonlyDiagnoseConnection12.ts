/**
 * READ-ONLY diagnosis — connection #12 / Woontegra WhatsApp visibility.
 * No writes. Run: npx ts-node src/scripts/readonlyDiagnoseConnection12.ts
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

  const out: Record<string, unknown> = {};

  const tbl = await c.query(
    `SELECT to_regclass('public.channel_connection_brand_shares') AS reg`
  );
  out.shares_table_exists = tbl.rows[0]?.reg != null;

  const conn = await c.query(
    `SELECT id, tenant_id, brand_id, channel_type, status, display_name, provider,
            (encrypted_credentials IS NOT NULL) AS has_credentials
     FROM channel_connections WHERE id = 12`
  );
  out.connection_12 = conn.rows[0] || null;

  if (conn.rows[0]) {
    const settingsRes = await c.query(`SELECT settings FROM channel_connections WHERE id = 12`);
    const settings = (settingsRes.rows[0]?.settings || {}) as Record<string, string>;
    out.waba_id = settings.waba_id || settings.wabaId || null;
    out.phone_number_id = settings.phone_number_id || null;
    out.display_phone =
      settings.business_phone_number || settings.business_phone || settings.display_phone || null;

    const brand = await c.query(`SELECT id, name FROM brands WHERE id = $1`, [conn.rows[0].brand_id]);
    out.owner_brand = brand.rows[0] || null;

    const senders = await c.query(
      `SELECT id, brand_id, is_active, is_verified, display_name, sender_value
       FROM sender_identities WHERE channel_connection_id = 12 ORDER BY id`
    );
    out.senders = senders.rows;
  }

  const woontegra = await c.query(
    `SELECT id, name, tenant_id FROM brands WHERE name ILIKE '%woontegra%' ORDER BY id`
  );
  out.woontegra_brands = woontegra.rows;

  const woontegraId = woontegra.rows[0]?.id;
  const tenantId = conn.rows[0]?.tenant_id;

  if (woontegraId && tenantId) {
    try {
      const listRes = await c.query(
        `SELECT cc.id, cc.brand_id, cc.status,
                CASE
                  WHEN $1::int IS NOT NULL AND cc.brand_id <> $1::int
                    AND EXISTS (
                      SELECT 1 FROM channel_connection_brand_shares sh
                      WHERE sh.tenant_id = cc.tenant_id
                        AND sh.channel_connection_id = cc.id
                        AND sh.brand_id = $1::int
                    )
                  THEN true
                  ELSE false
                END AS is_shared
         FROM channel_connections cc
         JOIN brands b ON b.id = cc.brand_id AND b.tenant_id = cc.tenant_id
         WHERE cc.tenant_id = $2
           AND cc.channel_type = 'WHATSAPP'
           AND (cc.brand_id = $3 OR EXISTS (
             SELECT 1 FROM channel_connection_brand_shares sh
             WHERE sh.tenant_id = cc.tenant_id
               AND sh.channel_connection_id = cc.id
               AND sh.brand_id = $3
           ))`,
        [woontegraId, tenantId, woontegraId]
      );
      out.list_query_ok = true;
      out.list_query_rows = listRes.rows;
    } catch (e: any) {
      out.list_query_ok = false;
      out.list_query_error = { code: e.code, message: e.message };
    }

    // Old query (pre-share): owner brand only
    const oldRes = await c.query(
      `SELECT cc.id, cc.brand_id, cc.status
       FROM channel_connections cc
       WHERE cc.tenant_id = $1 AND cc.brand_id = $2 AND cc.channel_type = 'WHATSAPP'`,
      [tenantId, woontegraId]
    );
    out.old_query_rows = oldRes.rows;
  }

  // Duplicate PNID check (post-dedupe filter)
  if (tenantId) {
    const allWa = await c.query(
      `SELECT id, brand_id, status, settings->>'phone_number_id' AS pnid, created_at
       FROM channel_connections
       WHERE tenant_id = $1 AND channel_type = 'WHATSAPP'
       ORDER BY created_at DESC`,
      [tenantId]
    );
    out.all_whatsapp_connections = allWa.rows;
  }

  // Test full GET list SQL paths
  if (tenantId) {
    try {
      const noBrand = await c.query(
        `SELECT cc.id,
                COALESCE((
                  SELECT json_agg(sh.brand_id ORDER BY sh.brand_id)
                  FROM channel_connection_brand_shares sh
                  WHERE sh.tenant_id = cc.tenant_id AND sh.channel_connection_id = cc.id
                ), '[]'::json) AS shared_brand_ids
         FROM channel_connections cc
         JOIN brands b ON b.id = cc.brand_id AND b.tenant_id = cc.tenant_id
         WHERE cc.tenant_id = $1 AND cc.channel_type = 'WHATSAPP'
         LIMIT 3`,
        [tenantId]
      );
      out.no_brand_filter_query_ok = true;
      out.no_brand_filter_rows = noBrand.rows;
    } catch (e: any) {
      out.no_brand_filter_query_ok = false;
      out.no_brand_filter_error = { code: e.code, message: e.message };
    }
  }

  console.log(JSON.stringify(out, null, 2));
  await c.end();
}

main().catch((e) => {
  console.error(JSON.stringify({ fatal: e.message, code: e.code }));
  process.exit(1);
});
