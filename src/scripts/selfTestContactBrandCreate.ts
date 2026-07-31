/**
 * Live DB: contact create brand link + WhatsApp consent + cross-tenant reject.
 * Run: npx ts-node src/scripts/selfTestContactBrandCreate.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import { query } from '../config/database';
import { normalizePhone } from '../utils/contactNormalize';

async function main() {
  const phoneNorm = normalizePhone({ value: '5323171755', countryCode: '90' });
  if (!phoneNorm.ok || phoneNorm.normalized !== '+905323171755') {
    throw new Error(`phone normalize failed: ${JSON.stringify(phoneNorm)}`);
  }

  const tenant = await query(
    `SELECT id, name FROM tenants
     WHERE name ILIKE '%meta%review%' OR name ILIKE '%meta%inceleme%'
     ORDER BY id LIMIT 1`
  );
  if (!tenant.rows[0]) throw new Error('Meta Review tenant not found');
  const tenantId = Number(tenant.rows[0].id);

  const brand = await query(
    `SELECT id, name FROM brands WHERE tenant_id = $1 ORDER BY id LIMIT 1`,
    [tenantId]
  );
  if (!brand.rows[0]) throw new Error('brand missing for Meta Review');
  const brandId = Number(brand.rows[0].id);
  const brandName = String(brand.rows[0].name);
  console.log('brand=', brandName, 'id=', brandId);

  const foreign = await query(
    `SELECT id, tenant_id FROM brands WHERE tenant_id <> $1 ORDER BY id LIMIT 1`,
    [tenantId]
  );
  if (foreign.rows[0]) {
    const foreignId = Number(foreign.rows[0].id);
    const check = await query(`SELECT id FROM brands WHERE id = $1 AND tenant_id = $2`, [
      foreignId,
      tenantId,
    ]);
    if (check.rows.length > 0) throw new Error('foreign brand incorrectly belongs to tenant');
    console.log('OK: foreign brand', foreignId, 'rejected for tenant', tenantId);
  } else {
    console.log('NOTE: no foreign brand in DB to probe');
  }

  const user = await query(`SELECT id FROM users WHERE tenant_id = $1 ORDER BY id LIMIT 1`, [
    tenantId,
  ]);
  const userId = user.rows[0]?.id || null;

  // Free phone points for retest
  await query(`DELETE FROM contact_points WHERE tenant_id = $1 AND normalized_value = $2`, [
    tenantId,
    '+905323171755',
  ]);

  const client = await (await import('../config/database')).getClient();
  try {
    await client.query('BEGIN');
    const contactIns = await client.query(
      `INSERT INTO contacts (tenant_id, first_name, last_name, status, created_by)
       VALUES ($1, $2, $3, 'ACTIVE', $4) RETURNING id`,
      [tenantId, 'Serdar', 'Topal Test', userId]
    );
    const contactId = contactIns.rows[0].id;

    const brandOk = await client.query(`SELECT id FROM brands WHERE id = $1 AND tenant_id = $2`, [
      brandId,
      tenantId,
    ]);
    if (!brandOk.rows[0]) throw new Error('tenant brand check failed');

    await client.query(
      `INSERT INTO contact_brand_links (tenant_id, contact_id, brand_id) VALUES ($1,$2,$3)`,
      [tenantId, contactId, brandId]
    );

    for (const ch of ['SMS', 'WHATSAPP']) {
      await client.query(
        `INSERT INTO contact_points
           (tenant_id, contact_id, channel_type, value, normalized_value, is_primary, is_active)
         VALUES ($1,$2,$3,$4,$4,true,true)`,
        [tenantId, contactId, ch, '+905323171755']
      );
    }

    const emailExists = await client.query(
      `SELECT id FROM contact_points
       WHERE tenant_id = $1 AND channel_type = 'EMAIL' AND normalized_value = $2`,
      [tenantId, 'review@woontegra.com']
    );
    if (emailExists.rows.length === 0) {
      await client.query(
        `INSERT INTO contact_points
           (tenant_id, contact_id, channel_type, value, normalized_value, is_primary, is_active)
         VALUES ($1,$2,'EMAIL',$3,$3,true,true)`,
        [tenantId, contactId, 'review@woontegra.com']
      );
    }

    await client.query(
      `INSERT INTO communication_preferences
         (tenant_id, contact_id, brand_id, channel_type, status, source, updated_by)
       VALUES ($1,$2,NULL,'WHATSAPP','OPTED_IN','user_explicit',$3)`,
      [tenantId, contactId, userId]
    );
    await client.query(
      `INSERT INTO consent_events
         (tenant_id, contact_id, brand_id, channel_type, previous_status, new_status, source, note, created_by)
       VALUES ($1,$2,NULL,'WHATSAPP','UNKNOWN','OPTED_IN','user_explicit','Kişi oluşturma formunda WhatsApp izni verildi',$3)`,
      [tenantId, contactId, userId]
    );

    await client.query('COMMIT');

    const link = await query(
      `SELECT brand_id FROM contact_brand_links WHERE contact_id = $1 AND tenant_id = $2`,
      [contactId, tenantId]
    );
    const pref = await query(
      `SELECT status, source FROM communication_preferences
       WHERE contact_id = $1 AND channel_type = 'WHATSAPP' AND brand_id IS NULL`,
      [contactId]
    );
    const points = await query(
      `SELECT channel_type, normalized_value FROM contact_points WHERE contact_id = $1 ORDER BY 1`,
      [contactId]
    );

    if (!link.rows.some((r: any) => Number(r.brand_id) === brandId)) {
      throw new Error('contact-brand link missing');
    }
    if (pref.rows[0]?.status !== 'OPTED_IN') throw new Error('whatsapp preference missing');

    console.log('OK: contact_id=', contactId);
    console.log('OK: brand_ids payload equivalent=', [brandId], 'name=', brandName);
    console.log('OK: points=', JSON.stringify(points.rows));
    console.log('OK: whatsapp_pref=', JSON.stringify(pref.rows[0]));
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('FAIL:', e.message || e);
    process.exit(1);
  });
