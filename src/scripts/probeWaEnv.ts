import dotenv from 'dotenv';
dotenv.config();
import { query } from '../config/database';

(async () => {
  const all = await query(`
    SELECT cc.id, cc.tenant_id, t.name AS tenant, cc.brand_id, b.name AS brand,
           cc.status, cc.display_name,
           cc.settings->>'business_phone_number' AS phone,
           cc.settings->>'phone_number_id' AS phone_number_id,
           cc.settings->>'waba_id' AS waba_id,
           cc.settings->>'connection_type' AS connection_type,
           cc.settings->>'connection_method' AS connection_method,
           (cc.encrypted_credentials IS NOT NULL) AS has_cred,
           cc.created_at, cc.updated_at
    FROM channel_connections cc
    JOIN tenants t ON t.id = cc.tenant_id
    LEFT JOIN brands b ON b.id = cc.brand_id
    WHERE cc.channel_type = 'WHATSAPP'
    ORDER BY cc.id
  `);
  console.log('ALL_WA', JSON.stringify(all.rows, null, 2));

  const sis = await query(`
    SELECT id, tenant_id, brand_id, channel_connection_id, display_name, sender_value, is_active, is_verified
    FROM sender_identities WHERE tenant_id = 35
  `);
  console.log('SI35', JSON.stringify(sis.rows, null, 2));

  const envKeys = [
    'META_APP_ID',
    'META_APP_SECRET',
    'META_WHATSAPP_CONFIG_ID',
    'META_SYSTEM_USER_TOKEN',
    'META_ACCESS_TOKEN',
    'WHATSAPP_ACCESS_TOKEN',
  ];
  for (const k of envKeys) {
    const v = process.env[k];
    console.log(k, v ? `present len=${v.length}` : 'missing');
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
