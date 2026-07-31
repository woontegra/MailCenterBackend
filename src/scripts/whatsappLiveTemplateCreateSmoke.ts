/**
 * Live Meta template create smoke test (uses local DB WhatsApp credentials).
 * Does not print tokens. Run only when local DB has the test WABA connection.
 *
 * npx ts-node src/scripts/whatsappLiveTemplateCreateSmoke.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import { query } from '../config/database';
import { createWabaMessageTemplate } from '../services/metaEmbeddedSignupService';
import { unpackWhatsAppCredentials, parseWhatsAppSettings } from '../whatsapp/whatsappCredentials';

const TARGET_WABA = '1546546623886797';
const NAME = 'destek_talebi_bildirimi';
const LANGUAGE = 'tr';
const CATEGORY = 'UTILITY';
const BODY =
  'Merhaba, destek talebiniz alınmıştır. Gelişme olduğunda sizi bilgilendireceğiz.';

async function main() {
  const result = await query(
    `SELECT * FROM channel_connections
     WHERE channel_type = 'WHATSAPP'
       AND status = 'ACTIVE'
       AND settings->>'waba_id' = $1
     ORDER BY id DESC LIMIT 1`,
    [TARGET_WABA]
  );
  if (!result.rows[0]) {
    console.log('SMOKE_SKIP: no ACTIVE local connection for WABA', TARGET_WABA);
    process.exit(0);
  }
  const connection = result.rows[0];
  const creds = unpackWhatsAppCredentials(connection.encrypted_credentials);
  const config = parseWhatsAppSettings(connection.settings);
  console.log('SMOKE using connection', {
    id: connection.id,
    tenantId: connection.tenant_id,
    brandId: connection.brand_id,
    wabaId: config.wabaId,
    phoneNumberId: config.phoneNumberId,
  });

  try {
    const created = await createWabaMessageTemplate({
      accessToken: creds.accessToken,
      wabaId: config.wabaId,
      name: NAME,
      language: LANGUAGE,
      category: CATEGORY,
      bodyText: BODY,
      apiVersion: config.apiVersion,
    });
    console.log('SMOKE_OK', created);
  } catch (err: any) {
    console.log('SMOKE_META_ERROR', {
      message: String(err?.message || '').slice(0, 400),
      code: err?.code || null,
      metaCode: err?.metaFailure?.code ?? null,
      metaSubcode: err?.metaFailure?.errorSubcode ?? null,
      httpStatus: err?.metaFailure?.httpStatus ?? null,
    });
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('SMOKE_FATAL', String(e?.message || e).slice(0, 300));
  process.exit(1);
});
