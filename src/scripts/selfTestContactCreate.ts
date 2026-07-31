/**
 * Live smoke: create Meta Review contact with E.164 phone + WhatsApp opt-in.
 * Run: npx ts-node src/scripts/selfTestContactCreate.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import { query } from '../config/database';
import { normalizePhone } from '../utils/contactNormalize';

async function main() {
  const phone = normalizePhone({ value: '5323171755', countryCode: '90' });
  if (!phone.ok || phone.normalized !== '+905323171755') {
    throw new Error(`normalize failed: ${JSON.stringify(phone)}`);
  }

  const tenant = await query(
    `SELECT id, name FROM tenants
     WHERE name ILIKE '%meta%review%' OR name ILIKE '%meta%inceleme%'
     ORDER BY id LIMIT 1`
  );
  if (!tenant.rows[0]) throw new Error('Meta Review tenant not found');
  const tenantId = tenant.rows[0].id as number;

  const brand = await query(
    `SELECT id, name FROM brands
     WHERE tenant_id = $1 AND (name ILIKE '%inceleme%' OR name ILIKE '%meta%')
     ORDER BY id LIMIT 1`,
    [tenantId]
  );
  if (!brand.rows[0]) throw new Error('Meta İnceleme Markası not found');
  const brandId = brand.rows[0].id as number;

  const user = await query(
    `SELECT id FROM users WHERE tenant_id = $1 ORDER BY id LIMIT 1`,
    [tenantId]
  );
  const userId = user.rows[0]?.id || null;

  // Clean prior test contact points for this phone
  await query(
    `DELETE FROM contact_points
     WHERE tenant_id = $1 AND normalized_value = $2`,
    [tenantId, '+905323171755']
  );

  const contactIns = await query(
    `INSERT INTO contacts
       (tenant_id, first_name, last_name, company_name, status, created_by)
     VALUES ($1, $2, $3, NULL, 'ACTIVE', $4)
     RETURNING id`,
    [tenantId, 'Serdar', 'Topal Test', userId]
  );
  const contactId = contactIns.rows[0].id as number;

  await query(
    `INSERT INTO contact_brand_links (tenant_id, contact_id, brand_id)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [tenantId, contactId, brandId]
  );

  for (const channel of ['SMS', 'WHATSAPP'] as const) {
    await query(
      `INSERT INTO contact_points
         (tenant_id, contact_id, channel_type, value, normalized_value, is_primary, is_active)
       VALUES ($1, $2, $3, $4, $4, true, true)`,
      [tenantId, contactId, channel, '+905323171755']
    );
  }

  const emailExists = await query(
    `SELECT id FROM contact_points
     WHERE tenant_id = $1 AND channel_type = 'EMAIL' AND normalized_value = $2 LIMIT 1`,
    [tenantId, 'review@woontegra.com']
  );
  if (emailExists.rows.length === 0) {
    await query(
      `INSERT INTO contact_points
         (tenant_id, contact_id, channel_type, value, normalized_value, is_primary, is_active)
       VALUES ($1, $2, 'EMAIL', $3, $3, true, true)`,
      [tenantId, contactId, 'review@woontegra.com']
    );
  } else {
    console.log('NOTE: email already on another contact — skipped EMAIL point');
  }

  await query(
    `INSERT INTO communication_preferences
       (tenant_id, contact_id, brand_id, channel_type, status, source, updated_by)
     VALUES ($1, $2, NULL, 'WHATSAPP', 'OPTED_IN', 'user_explicit', $3)`,
    [tenantId, contactId, userId]
  );

  await query(
    `INSERT INTO consent_events
       (tenant_id, contact_id, brand_id, channel_type, previous_status, new_status, source, note, created_by)
     VALUES ($1, $2, NULL, 'WHATSAPP', 'UNKNOWN', 'OPTED_IN', 'user_explicit',
             'Kişi oluşturma formunda WhatsApp izni verildi', $3)`,
    [tenantId, contactId, userId]
  );

  const stored = await query(
    `SELECT channel_type, value, normalized_value FROM contact_points
     WHERE contact_id = $1 AND tenant_id = $2 ORDER BY channel_type`,
    [contactId, tenantId]
  );
  const pref = await query(
    `SELECT status, source, updated_by FROM communication_preferences
     WHERE contact_id = $1 AND channel_type = 'WHATSAPP' AND brand_id IS NULL`,
    [contactId]
  );

  console.log('OK: contact_id=', contactId);
  console.log('tenant=', tenant.rows[0].name, 'brand=', brand.rows[0].name, 'brand_id=', brandId);
  console.log('points=', JSON.stringify(stored.rows));
  console.log('whatsapp_pref=', JSON.stringify(pref.rows[0]));

  for (const p of stored.rows) {
    if (p.channel_type !== 'EMAIL' && p.normalized_value !== '+905323171755') {
      throw new Error(`phone not E.164: ${p.normalized_value}`);
    }
  }
  if (pref.rows[0]?.status !== 'OPTED_IN') throw new Error('preference not OPTED_IN');

  // Duplicate must be detectable for 409 path
  const dup = await query(
    `SELECT id FROM contact_points
     WHERE tenant_id = $1 AND channel_type = 'WHATSAPP' AND normalized_value = $2`,
    [tenantId, '+905323171755']
  );
  if (dup.rows.length === 0) throw new Error('expected existing point for duplicate check');
  console.log('OK: duplicate detection row exists');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('FAIL:', e.message || e);
    process.exit(1);
  });
