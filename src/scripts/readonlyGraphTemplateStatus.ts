/**
 * READ-ONLY Graph GET for one WABA template (no writes).
 * Run: npx ts-node src/scripts/readonlyGraphTemplateStatus.ts mc_odeme_vadesi_gecmis
 */
import dotenv from 'dotenv';
import { query } from '../config/database';
import { graphApiBase, getMetaGraphApiVersion } from '../config/metaWhatsAppConfig';
import { unpackWhatsAppCredentials, parseWhatsAppSettings } from '../whatsapp/whatsappCredentials';

dotenv.config();

const WABA = '420529479291363';
const CONN_ID = 12;
const TEMPLATE_NAME = process.argv[2] || 'mc_odeme_vadesi_gecmis';

async function graphGet(url: string, token: string) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = (await res.json()) as any;
  return { status: res.status, data };
}

async function main() {
  const conn = await query(
    `SELECT encrypted_credentials, settings FROM channel_connections WHERE id = $1`,
    [CONN_ID]
  );
  if (!conn.rows[0]) throw new Error('connection 12 not found');
  const creds = unpackWhatsAppCredentials(conn.rows[0].encrypted_credentials);
  const config = parseWhatsAppSettings(conn.rows[0].settings);
  const version = config.apiVersion || getMetaGraphApiVersion();
  const token = creds.accessToken;

  const listUrl =
    `${graphApiBase(version)}/${encodeURIComponent(WABA)}/message_templates` +
    `?limit=100&fields=id,name,language,status,category,rejected_reason,quality_score`;

  const list = await graphGet(listUrl, token);
  const rows = Array.isArray(list.data?.data) ? list.data.data : [];
  const hit = rows.find((r: any) => String(r.name) === TEMPLATE_NAME);

  const dbRows = await query(
    `SELECT id, brand_id, library_key, provider_approval_status, provider_template_components, provider_rejection_reason
     FROM templates
     WHERE tenant_id = 5 AND channel_type = 'WHATSAPP'
       AND provider_template_name = $1
     ORDER BY brand_id, id`,
    [TEMPLATE_NAME]
  );

  console.log(
    JSON.stringify(
      {
        http_status: list.status,
        graph_error: list.data?.error?.message || null,
        template: hit
          ? {
              id: hit.id,
              name: hit.name,
              language: hit.language,
              status: hit.status,
              quality_score: hit.quality_score ?? null,
              rejected_reason: hit.rejected_reason ?? null,
              category: hit.category ?? null,
            }
          : null,
        local_rows: dbRows.rows.map((r) => ({
          id: r.id,
          brand_id: r.brand_id,
          library_key: r.library_key,
          provider_approval_status: r.provider_approval_status,
          provider_rejection_reason: r.provider_rejection_reason,
          meta_status: (r.provider_template_components as any)?.status ?? null,
          quality_score: (r.provider_template_components as any)?.quality_score ?? null,
        })),
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
