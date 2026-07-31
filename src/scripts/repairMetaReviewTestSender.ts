/**
 * Backfill Meta Review test WABA on legacy templates + optional credential refresh for connection 11.
 *
 * Usage:
 *   npx tsx src/scripts/repairMetaReviewTestSender.ts --backfill-only
 *   npx tsx src/scripts/repairMetaReviewTestSender.ts --apply --access-token=...
 *
 * Never logs the access token.
 */
import 'dotenv/config';
import { query, pool } from '../config/database';
import { packPlatformWhatsAppCredentials } from '../services/metaEmbeddedSignupService';
import { syncWhatsAppTemplatesForConnection } from '../services/whatsappTemplateSyncService';
import { unpackWhatsAppCredentials } from '../whatsapp/whatsappCredentials';

const CONNECTION_ID = 11;
const TENANT_ID = 35;
const BRAND_ID = 13;
const WABA_ID = '1546546623886797';
const PHONE_NUMBER_ID = '1250707658121285';

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const apply = hasFlag('apply');
  const backfillOnly = hasFlag('backfill-only');
  const accessToken =
    arg('access-token') ||
    process.env.META_SYSTEM_USER_TOKEN ||
    process.env.META_ACCESS_TOKEN ||
    process.env.WHATSAPP_ACCESS_TOKEN ||
    '';

  const conn = (
    await query(
      `SELECT id, tenant_id, brand_id, status, encrypted_credentials, settings
       FROM channel_connections WHERE id = $1 AND tenant_id = $2`,
      [CONNECTION_ID, TENANT_ID]
    )
  ).rows[0];
  if (!conn) {
    throw new Error(`connection ${CONNECTION_ID} not found for tenant ${TENANT_ID}`);
  }

  const beforeNull = (
    await query(
      `SELECT COUNT(*)::int AS n FROM templates
       WHERE tenant_id = $1 AND brand_id = $2 AND channel_type = 'WHATSAPP'
         AND provider_waba_id IS NULL
         AND NULLIF(TRIM(COALESCE(provider_template_name, '')), '') IS NOT NULL`,
      [TENANT_ID, BRAND_ID]
    )
  ).rows[0].n;

  console.log(
    JSON.stringify({
      connection_id: CONNECTION_ID,
      status: conn.status,
      templates_null_waba: beforeNull,
      apply,
      backfillOnly,
      has_access_token_input: Boolean(String(accessToken).trim()),
    })
  );

  if (apply || backfillOnly) {
    const upd = await query(
      `UPDATE templates
       SET provider_waba_id = $1,
           channel_connection_id = COALESCE(channel_connection_id, $2),
           updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $3 AND brand_id = $4 AND channel_type = 'WHATSAPP'
         AND provider_waba_id IS NULL
         AND NULLIF(TRIM(COALESCE(provider_template_name, '')), '') IS NOT NULL
       RETURNING id, provider_template_name, provider_approval_status`,
      [WABA_ID, CONNECTION_ID, TENANT_ID, BRAND_ID]
    );
    console.log(
      JSON.stringify({
        backfilled: upd.rows.length,
        names: upd.rows.map((r: any) => ({
          id: r.id,
          name: r.provider_template_name,
          status: r.provider_approval_status,
        })),
      })
    );
  }

  if (backfillOnly) {
    return;
  }

  if (!apply) {
    console.log('dry-run: pass --apply --access-token=... to refresh credentials + sync');
    return;
  }

  if (!String(accessToken).trim()) {
    throw new Error('access token required for --apply (env or --access-token=)');
  }

  const encrypted = packPlatformWhatsAppCredentials(String(accessToken).trim());
  // Verify pack without printing secrets
  const unpacked = unpackWhatsAppCredentials(encrypted);
  if (unpacked.accessToken.length < 20) {
    throw new Error('packed token invalid');
  }

  const settings =
    typeof conn.settings === 'string' ? JSON.parse(conn.settings) : { ...(conn.settings || {}) };
  settings.waba_id = settings.waba_id || WABA_ID;
  settings.phone_number_id = settings.phone_number_id || PHONE_NUMBER_ID;
  settings.business_phone_number = settings.business_phone_number || '+1 555-154-8955';
  settings.last_error = null;
  settings.credentials_refreshed_at = new Date().toISOString();

  await query(
    `UPDATE channel_connections
     SET encrypted_credentials = $1,
         status = 'ACTIVE',
         settings = $2::jsonb,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $3 AND tenant_id = $4`,
    [encrypted, JSON.stringify(settings), CONNECTION_ID, TENANT_ID]
  );
  console.log(JSON.stringify({ credentials_refreshed: true, connection_id: CONNECTION_ID }));

  // Live Graph check (no token log)
  const r = await fetch(
    `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}?fields=id,display_phone_number,verified_name`,
    { headers: { Authorization: `Bearer ${unpacked.accessToken}` } }
  );
  const j: any = await r.json();
  console.log(
    JSON.stringify({
      graph_status: r.status,
      graph_ok: r.ok && !j.error,
      graph_error: j.error
        ? { code: j.error.code, type: j.error.type, message: String(j.error.message).slice(0, 160) }
        : null,
      display: j.display_phone_number || null,
    })
  );
  if (!r.ok || j.error) {
    throw new Error('Graph rejected refreshed token');
  }

  const sync = await syncWhatsAppTemplatesForConnection({
    tenantId: TENANT_ID,
    connectionId: CONNECTION_ID,
  });
  console.log(
    JSON.stringify({
      synced: sync.synced,
      approved: sync.approved,
      sample: sync.templates
        .filter((t) => t.status === 'APPROVED')
        .slice(0, 8)
        .map((t) => `${t.name}/${t.language}`),
    })
  );
}

main()
  .catch((e) => {
    console.error(String(e?.message || e));
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await pool.end();
    } catch {
      /* ignore */
    }
  });
