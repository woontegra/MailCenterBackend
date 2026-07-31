import { query } from '../config/database';
import {
  fetchWabaMessageTemplates,
  MetaMessageTemplate,
} from './metaEmbeddedSignupService';
import { unpackWhatsAppCredentials, parseWhatsAppSettings } from '../whatsapp/whatsappCredentials';
import { sanitizeOutboundErrorMessage } from '../config/outboundQueue';

function mapMetaStatusToApproval(status: string): string {
  const s = String(status || '').toUpperCase();
  if (s === 'APPROVED') return 'APPROVED';
  if (s === 'REJECTED' || s === 'DISABLED') return 'REJECTED';
  if (s === 'PENDING' || s === 'IN_APPEAL' || s === 'PAUSED') return 'PENDING';
  return 'UNKNOWN';
}

/**
 * Pull message templates from Meta WABA and upsert into local templates table.
 */
export async function syncWhatsAppTemplatesForConnection(params: {
  tenantId: number;
  connectionId: number;
}): Promise<{ synced: number; approved: number; templates: MetaMessageTemplate[] }> {
  const result = await query(
    `SELECT * FROM channel_connections
     WHERE id = $1 AND tenant_id = $2 AND channel_type = 'WHATSAPP'`,
    [params.connectionId, params.tenantId]
  );
  if (result.rows.length === 0) {
    throw Object.assign(new Error('WhatsApp bağlantısı bulunamadı'), { code: 'NOT_FOUND' });
  }
  const connection = result.rows[0];
  const creds = unpackWhatsAppCredentials(connection.encrypted_credentials);
  const config = parseWhatsAppSettings(connection.settings);
  const remote = await fetchWabaMessageTemplates({
    accessToken: creds.accessToken,
    wabaId: config.wabaId,
    apiVersion: config.apiVersion,
  });

  let synced = 0;
  let approved = 0;
  const now = new Date();

  for (const tpl of remote) {
    if (!tpl.name || !tpl.language) continue;
    if (String(tpl.status).toUpperCase() === 'APPROVED') approved += 1;

    const existing = await query(
      `SELECT id FROM templates
       WHERE tenant_id = $1
         AND brand_id = $2
         AND channel_type = 'WHATSAPP'
         AND provider_template_name = $3
         AND provider_template_language = $4
       LIMIT 1`,
      [params.tenantId, connection.brand_id, tpl.name, tpl.language]
    );

    const approval = mapMetaStatusToApproval(tpl.status);
    const displayName = `${tpl.name} (${tpl.language})`;
    const bodyText =
      Array.isArray(tpl.components)
        ? (tpl.components as any[])
            .filter((c) => String(c?.type || '').toUpperCase() === 'BODY')
            .map((c) => c.text)
            .filter(Boolean)
            .join('\n') || displayName
        : displayName;

    if (existing.rows[0]?.id) {
      await query(
        `UPDATE templates SET
           name = $1,
           plain_text_content = COALESCE(NULLIF(plain_text_content, ''), $2),
           provider_approval_status = $3,
           provider_template_components = $4::jsonb,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $5 AND tenant_id = $6`,
        [
          displayName,
          bodyText,
          approval,
          JSON.stringify({
            meta_template_id: tpl.id,
            category: tpl.category,
            status: tpl.status,
            components: tpl.components,
            last_synced_at: now.toISOString(),
          }),
          existing.rows[0].id,
          params.tenantId,
        ]
      );
    } else {
      await query(
        `INSERT INTO templates (
           tenant_id, brand_id, name, content, channel_type, plain_text_content,
           provider_template_name, provider_template_language,
           provider_approval_status, provider_template_components, is_active, is_draft
         ) VALUES (
           $1,$2,$3,$4,'WHATSAPP',$4,$5,$6,$7,$8::jsonb,true,false
         )`,
        [
          params.tenantId,
          connection.brand_id,
          displayName,
          bodyText,
          tpl.name,
          tpl.language,
          approval,
          JSON.stringify({
            meta_template_id: tpl.id,
            category: tpl.category,
            status: tpl.status,
            components: tpl.components,
            last_synced_at: now.toISOString(),
          }),
        ]
      );
    }
    synced += 1;
  }

  const settings = {
    ...(connection.settings || {}),
    templates_last_synced_at: now.toISOString(),
    approved_template_count: approved,
    last_template_sync_error: null,
  };
  // Never flip connection status to ERROR on template sync — keep ACTIVE / webhook as-is.
  await query(
    `UPDATE channel_connections
     SET settings = $1::jsonb, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2 AND tenant_id = $3`,
    [JSON.stringify(settings), params.connectionId, params.tenantId]
  );

  return { synced, approved, templates: remote };
}

export function safeTemplateSyncError(err: any): string {
  return sanitizeOutboundErrorMessage(err?.message || 'Şablon senkronizasyonu başarısız');
}
