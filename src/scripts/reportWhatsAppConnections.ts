/**
 * Report WHATSAPP channel_connections for Meta Review (no secrets).
 * Run: npx ts-node src/scripts/reportWhatsAppConnections.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import { query } from '../config/database';

function maskPhone(p: string | null | undefined) {
  if (!p) return null;
  return String(p);
}

async function main() {
  const tenants = await query(
    `SELECT id, name, contact_email FROM tenants
     WHERE name ILIKE '%meta%review%' OR name ILIKE '%meta%inceleme%'
        OR contact_email ILIKE '%review@woontegra%'
     ORDER BY id`
  );
  console.log('=== TENANTS ===');
  console.log(JSON.stringify(tenants.rows, null, 2));

  for (const t of tenants.rows) {
    const brands = await query(
      `SELECT id, name, slug FROM brands WHERE tenant_id = $1 ORDER BY id`,
      [t.id]
    );
    console.log(`\n=== BRANDS tenant=${t.id} ${t.name} ===`);
    console.log(JSON.stringify(brands.rows, null, 2));

    const conns = await query(
      `SELECT
         cc.id,
         cc.tenant_id,
         cc.brand_id,
         b.name AS brand_name,
         cc.status,
         cc.channel_type,
         cc.display_name,
         cc.encrypted_credentials IS NOT NULL AND length(cc.encrypted_credentials) > 0 AS has_credentials,
         cc.settings,
         cc.created_at,
         cc.updated_at
       FROM channel_connections cc
       LEFT JOIN brands b ON b.id = cc.brand_id AND b.tenant_id = cc.tenant_id
       WHERE cc.tenant_id = $1 AND cc.channel_type = 'WHATSAPP'
       ORDER BY cc.id`,
      [t.id]
    );

    console.log(`\n=== WHATSAPP CONNECTIONS tenant=${t.id} count=${conns.rows.length} ===`);
    for (const row of conns.rows) {
      const s = row.settings || {};
      const phone =
        s.business_phone_number ||
        s.business_phone ||
        s.display_phone_number ||
        s.phone_number ||
        null;
      const report = {
        id: row.id,
        tenant_id: row.tenant_id,
        brand_id: row.brand_id,
        brand_name: row.brand_name,
        status: row.status,
        channel_type: row.channel_type,
        display_name: row.display_name,
        phone_number: maskPhone(phone),
        phone_number_id: s.phone_number_id || null,
        waba_id: s.waba_id || null,
        connection_type: s.connection_type || s.connection_method || null,
        coexistence: s.coexistence ?? null,
        verified_name: s.verified_name || null,
        has_credentials: row.has_credentials,
        created_at: row.created_at,
        updated_at: row.updated_at,
        settings_keys: Object.keys(s).sort(),
      };
      console.log(JSON.stringify(report, null, 2));
    }

    const templates = await query(
      `SELECT id, brand_id, name, provider_template_name, provider_template_language,
              provider_approval_status, is_active, channel_type, updated_at
       FROM templates
       WHERE tenant_id = $1 AND channel_type = 'WHATSAPP'
       ORDER BY brand_id, id`,
      [t.id]
    );
    console.log(`\n=== WA TEMPLATES tenant=${t.id} count=${templates.rows.length} ===`);
    console.log(JSON.stringify(templates.rows, null, 2));

    const sis = await query(
      `SELECT id, brand_id, channel_connection_id, display_name, channel_type,
              is_active, is_verified, settings, created_at
       FROM sender_identities
       WHERE tenant_id = $1 AND channel_type = 'WHATSAPP'
       ORDER BY id`,
      [t.id]
    );
    console.log(`\n=== WA SENDER_IDENTITIES tenant=${t.id} count=${sis.rows.length} ===`);
    for (const row of sis.rows) {
      const s = row.settings || {};
      console.log(
        JSON.stringify(
          {
            id: row.id,
            brand_id: row.brand_id,
            channel_connection_id: row.channel_connection_id,
            display_name: row.display_name,
            is_active: row.is_active,
            is_verified: row.is_verified,
            phone_number: s.business_phone_number || s.business_phone || null,
            phone_number_id: s.phone_number_id || null,
            created_at: row.created_at,
          },
          null,
          2
        )
      );
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('FAIL', e.message || e);
    process.exit(1);
  });
