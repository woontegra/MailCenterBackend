/**
 * Repair / report WhatsApp channel connections for a tenant (Meta Review).
 *
 * Usage:
 *   npx ts-node src/scripts/repairWhatsAppChannelConnection.ts --dry-run
 *   npx ts-node src/scripts/repairWhatsAppChannelConnection.ts --email=review@woontegra.com --dry-run
 *   npx ts-node src/scripts/repairWhatsAppChannelConnection.ts --apply --access-token=... --waba-id=... --phone-number-id=...
 *
 * Never prints access tokens.
 */
import dotenv from 'dotenv';
dotenv.config();

import { query } from '../config/database';
import { packPlatformWhatsAppCredentials } from '../services/metaEmbeddedSignupService';
import {
  fetchPhoneNumberProfile,
  fetchWabaProfile,
  listWabaPhoneNumbers,
  resolvePhoneNumberIdForWaba,
} from '../services/metaEmbeddedSignupService';
import { syncWhatsAppTemplatesForConnection } from '../services/whatsappTemplateSyncService';
import { getMetaGraphApiVersion } from '../config/metaWhatsAppConfig';
import { isMetaTestWhatsAppPhone, whatsappPhoneDigits } from '../utils/channelPlatform';

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function summarizeConn(row: any) {
  const s = row.settings || {};
  const phone =
    s.business_phone_number || s.business_phone || s.display_phone_number || null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    brand_id: row.brand_id,
    status: row.status,
    display_name: row.display_name,
    phone_number: phone,
    phone_number_id: s.phone_number_id || null,
    waba_id: s.waba_id || null,
    connection_type: s.connection_type || s.connection_method || null,
    has_credentials: Boolean(row.encrypted_credentials),
    is_meta_test: isMetaTestWhatsAppPhone(phone),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function main() {
  const dryRun = !hasFlag('apply');
  const email = arg('email') || 'review@woontegra.com';
  const accessToken = arg('access-token') || process.env.REPAIR_WA_ACCESS_TOKEN || '';
  let wabaId = arg('waba-id') || process.env.REPAIR_WA_WABA_ID || '';
  let phoneNumberId = arg('phone-number-id') || process.env.REPAIR_WA_PHONE_NUMBER_ID || '';
  const preferredPhone = arg('phone') || '+905323171755';

  const tenant = await query(
    `SELECT id, name, contact_email FROM tenants
     WHERE contact_email ILIKE $1 OR name ILIKE '%meta%review%'
     ORDER BY CASE WHEN contact_email ILIKE $1 THEN 0 ELSE 1 END, id
     LIMIT 1`,
    [email]
  );
  if (!tenant.rows[0]) throw new Error(`tenant not found for ${email}`);
  const tenantId = Number(tenant.rows[0].id);
  console.log('tenant', JSON.stringify(tenant.rows[0]));

  const brand = await query(
    `SELECT id, name FROM brands WHERE tenant_id = $1 ORDER BY id LIMIT 1`,
    [tenantId]
  );
  if (!brand.rows[0]) throw new Error('brand missing');
  const brandId = Number(brand.rows[0].id);
  console.log('brand', JSON.stringify(brand.rows[0]));

  const conns = await query(
    `SELECT * FROM channel_connections
     WHERE tenant_id = $1 AND brand_id = $2 AND channel_type = 'WHATSAPP'
     ORDER BY id`,
    [tenantId, brandId]
  );
  console.log('=== EXISTING CONNECTIONS ===');
  for (const row of conns.rows) console.log(JSON.stringify(summarizeConn(row)));

  const testRows = conns.rows.filter((r: any) =>
    isMetaTestWhatsAppPhone((r.settings || {}).business_phone_number)
  );
  const realRows = conns.rows.filter((r: any) => {
    const phone = (r.settings || {}).business_phone_number;
    const digits = whatsappPhoneDigits(phone);
    return digits === '905323171755' || digits.endsWith('5323171755');
  });

  console.log(
    JSON.stringify({
      dryRun,
      test_connection_count: testRows.length,
      real_connection_count: realRows.length,
      root_cause:
        realRows.length === 0
          ? 'NO_REAL_CONNECTION: +905323171755 never saved as ACTIVE channel_connection'
          : 'REAL_CONNECTION_PRESENT',
    })
  );

  // Backfill provider_waba_id on brand templates from each connection
  if (!dryRun) {
    for (const row of conns.rows) {
      const waba = String(row.settings?.waba_id || '').trim();
      if (!waba) continue;
      await query(
        `UPDATE templates
         SET provider_waba_id = COALESCE(provider_waba_id, $1),
             channel_connection_id = COALESCE(channel_connection_id, $2)
         WHERE tenant_id = $3 AND brand_id = $4 AND channel_type = 'WHATSAPP'
           AND provider_waba_id IS NULL`,
        [waba, row.id, tenantId, brandId]
      );
    }
    console.log('backfilled provider_waba_id where null');
  }

  if (realRows.length > 0) {
    console.log('OK: real connection already present', summarizeConn(realRows[0]));
    process.exit(0);
  }

  if (!accessToken) {
    console.log(
      'ACTION_REQUIRED: Re-run WhatsApp Business App (coexistence) Embedded Signup for this brand, OR re-run with --apply --access-token=... --waba-id=... --phone-number-id=...'
    );
    console.log(
      'NOTE: existing Meta test connection token is expired; test sender cannot send until refreshed.'
    );
    process.exit(dryRun ? 0 : 2);
  }

  if (!wabaId) {
    throw new Error('waba-id required when applying with access token');
  }

  if (!phoneNumberId) {
    const resolved = await resolvePhoneNumberIdForWaba({
      accessToken,
      wabaId,
      preferredDisplayPhone: preferredPhone,
    });
    phoneNumberId = resolved.phoneNumberId;
    console.log(
      'resolved_phone',
      JSON.stringify({
        phoneNumberId,
        display: resolved.displayPhoneNumber,
        onBiz: resolved.isOnBizApp,
      })
    );
  }

  const phones = await listWabaPhoneNumbers({ accessToken, wabaId });
  console.log(
    'waba_phones',
    JSON.stringify(
      phones.map((p) => ({
        id: p.phoneNumberId,
        phone: p.displayPhoneNumber,
        name: p.verifiedName,
        onBiz: p.isOnBizApp,
      }))
    )
  );

  const phone = await fetchPhoneNumberProfile({ accessToken, phoneNumberId });
  const waba = await fetchWabaProfile({ accessToken, wabaId });
  const digits = whatsappPhoneDigits(phone.displayPhoneNumber);
  if (digits !== '905323171755' && !digits.endsWith('5323171755')) {
    throw new Error(
      `Resolved phone is not +905323171755 (got ${phone.displayPhoneNumber}). Refusing to write.`
    );
  }
  if (isMetaTestWhatsAppPhone(phone.displayPhoneNumber)) {
    throw new Error('Refusing to overwrite/create with Meta test number');
  }

  const settings = {
    waba_id: wabaId,
    phone_number_id: phoneNumberId,
    business_phone_number: phone.displayPhoneNumber,
    verified_name: phone.verifiedName,
    quality_rating: phone.qualityRating,
    waba_name: waba.name,
    api_version: getMetaGraphApiVersion(),
    webhook_status: 'SUBSCRIBED',
    connection_method: 'EMBEDDED_SIGNUP',
    connection_type: 'WHATSAPP_BUSINESS_APP_ONBOARDING',
    coexistence: true,
    last_error: null,
  };
  const displayName = phone.verifiedName || phone.displayPhoneNumber || 'WhatsApp Business';
  const encrypted = packPlatformWhatsAppCredentials(accessToken);

  console.log(
    'planned_write',
    JSON.stringify({
      displayName,
      phone: phone.displayPhoneNumber,
      phoneNumberId,
      wabaId,
      connection_type: settings.connection_type,
      dryRun,
    })
  );

  if (dryRun) {
    console.log('dry-run complete — no writes');
    process.exit(0);
  }

  // Never update test connection rows
  for (const t of testRows) {
    console.log('preserving_test_connection_id', t.id);
  }

  const inserted = await query(
    `INSERT INTO channel_connections
      (tenant_id, brand_id, channel_type, provider, display_name, status,
       encrypted_credentials, settings, last_tested_at)
     VALUES ($1,$2,'WHATSAPP','META_WHATSAPP_CLOUD',$3,'ACTIVE',$4,$5::jsonb,CURRENT_TIMESTAMP)
     RETURNING *`,
    [tenantId, brandId, displayName, encrypted, JSON.stringify(settings)]
  );
  const connection = inserted.rows[0];
  console.log('created_connection', JSON.stringify(summarizeConn(connection)));

  await query(
    `INSERT INTO sender_identities
      (tenant_id, brand_id, channel_connection_id, channel_type, display_name, sender_value, is_default, is_active, is_verified)
     VALUES ($1,$2,$3,'WHATSAPP',$4,$5,false,true,true)`,
    [tenantId, brandId, connection.id, displayName, phone.displayPhoneNumber]
  );

  try {
    const sync = await syncWhatsAppTemplatesForConnection({
      tenantId,
      connectionId: connection.id,
    });
    console.log('template_sync', JSON.stringify({ synced: sync.synced, approved: sync.approved }));
  } catch (e: any) {
    console.log('template_sync_failed', e.message);
  }

  console.log('APPLY_OK');
}

main().catch((e) => {
  console.error('FAIL', e.message || e);
  process.exit(1);
});
