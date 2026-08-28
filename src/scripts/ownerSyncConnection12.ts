/**
 * Owner-only template sync for connection #12 (Woontegra brand 6).
 * Run: npx ts-node src/scripts/ownerSyncConnection12.ts
 */
import dotenv from 'dotenv';
import { query } from '../config/database';
import { syncWhatsAppTemplatesForConnection } from '../services/whatsappTemplateSyncService';

dotenv.config();

const TEMPLATE_NAME = 'mc_odeme_vadesi_gecmis';

async function main() {
  const result = await syncWhatsAppTemplatesForConnection({
    tenantId: 5,
    connectionId: 12,
    requestingBrandId: 6,
  });

  const rows = await query(
    `SELECT id, brand_id, library_key, provider_approval_status, provider_rejection_reason,
            provider_template_components
     FROM templates
     WHERE tenant_id = 5 AND channel_type = 'WHATSAPP'
       AND provider_template_name = $1
     ORDER BY brand_id, id`,
    [TEMPLATE_NAME]
  );

  console.log(
    JSON.stringify(
      {
        synced: result.synced,
        approved: result.approved,
        remote_hit: result.templates.find((t) => t.name === TEMPLATE_NAME) || null,
        local_rows: rows.rows.map((r) => ({
          id: r.id,
          brand_id: r.brand_id,
          library_key: r.library_key,
          provider_approval_status: r.provider_approval_status,
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
  console.error(e.message || e);
  process.exit(1);
});
