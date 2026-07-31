/**
 * Probe Graph with existing Meta Review connection token (no token print).
 */
import dotenv from 'dotenv';
dotenv.config();
import { query } from '../config/database';
import { unpackWhatsAppCredentials } from '../whatsapp/whatsappCredentials';
import { getMetaGraphApiVersion, getMetaAppId } from '../config/metaWhatsAppConfig';

async function graphGet(path: string, token: string): Promise<{ ok: boolean; status: number; data: any }> {
  const version = getMetaGraphApiVersion();
  const url = `https://graph.facebook.com/${version}${path}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function summarizePhones(rows: any[]) {
  return (rows || []).map((p: any) => ({
    id: p.id,
    phone: p.display_phone_number,
    name: p.verified_name,
    on_biz: p.is_on_biz_app,
  }));
}

(async () => {
  const row = await query(
    `SELECT id, encrypted_credentials, settings FROM channel_connections WHERE id = 11`
  );
  if (!row.rows[0]) throw new Error('connection 11 missing');
  const creds = unpackWhatsAppCredentials(row.rows[0].encrypted_credentials);
  const token = creds.accessToken;
  console.log('token_present', Boolean(token), 'len', token?.length || 0);
  console.log('app_id', getMetaAppId() ? 'present' : 'missing');

  const debug = await graphGet(`/debug_token?input_token=${encodeURIComponent(token)}`, token);
  console.log('debug_status', debug.status);
  if (debug.data?.data) {
    const d = debug.data.data;
    console.log(
      'debug',
      JSON.stringify({
        app_id: d.app_id,
        type: d.type,
        is_valid: d.is_valid,
        scopes: d.scopes,
        granular_scopes: d.granular_scopes,
        expires_at: d.expires_at,
      })
    );
  } else {
    console.log('debug_err', debug.data?.error?.message || Object.keys(debug.data || {}));
  }

  const me = await graphGet('/me?fields=id,name', token);
  console.log(
    'me',
    me.status,
    JSON.stringify({ id: me.data?.id, name: me.data?.name, error: me.data?.error?.message })
  );

  const wabaId = row.rows[0].settings?.waba_id;
  const phones = await graphGet(
    `/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,is_on_biz_app`,
    token
  );
  console.log('phones_on_test_waba', phones.status, JSON.stringify(summarizePhones(phones.data?.data)));

  for (const path of [
    '/me/client_whatsapp_business_accounts?fields=id,name,phone_numbers{id,display_phone_number,verified_name,is_on_biz_app}&limit=20',
    '/me/owned_whatsapp_business_accounts?fields=id,name,phone_numbers{id,display_phone_number,verified_name,is_on_biz_app}&limit=20',
  ]) {
    const res = await graphGet(path, token);
    console.log(path.split('?')[0], res.status);
    if (Array.isArray(res.data?.data)) {
      for (const w of res.data.data) {
        console.log(
          'waba',
          JSON.stringify({
            id: w.id,
            name: w.name,
            phones: summarizePhones(w.phone_numbers?.data),
          })
        );
      }
    } else {
      console.log('err', res.data?.error?.message || res.data);
    }
  }

  process.exit(0);
})().catch((e) => {
  console.error('FAIL', e.message || e);
  process.exit(1);
});
