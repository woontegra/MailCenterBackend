import { query } from '../config/database';
import {
  fetchWabaMessageTemplates,
  MetaMessageTemplate,
} from './metaEmbeddedSignupService';
import { unpackWhatsAppCredentials, parseWhatsAppSettings } from '../whatsapp/whatsappCredentials';
import { sanitizeOutboundErrorMessage } from '../config/outboundQueue';
import { getReadyTemplateByProviderName } from '../whatsapp/whatsappReadyTemplateCatalog';
import {
  buildProviderComponentsPayload,
  mapMetaStatusToApproval,
} from '../utils/whatsappTemplateStatus';

export { mapMetaStatusToApproval } from '../utils/whatsappTemplateStatus';

/** Translate common Meta rejection codes/messages into clear Turkish copy for end users. */
export function humanizeWhatsAppTemplateRejection(
  raw: string | null | undefined
): string | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  const upper = s.toUpperCase();
  if (upper.includes('INVALID') && upper.includes('FORMAT')) {
    return 'Meta şablon metnini veya değişken biçimini geçersiz buldu. Örnek değerleri ve metni kontrol edin.';
  }
  if (upper.includes('SCAM') || upper.includes('ABUS')) {
    return 'Meta içeriği politikaya aykırı bulduğu için reddetti. Metni daha net ve ticari kurallara uygun hale getirin.';
  }
  if (upper.includes('PROMOTIONAL') || upper.includes('CATEGORY')) {
    return 'Meta, şablon kategorisini içerikle uyumsuz buldu. Yardımcı (UTILITY) veya pazarlama (MARKETING) seçimini gözden geçirin.';
  }
  if (upper.includes('DUPLICATE') || upper.includes('ALREADY EXISTS')) {
    return 'Bu isimde bir şablon WhatsApp hesabınızda zaten var.';
  }
  if (upper === 'NONE' || upper === 'NULL') return null;
  return s
    .replace(/EAA[A-Za-z0-9]+/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 400);
}

/**
 * Pull message templates from Meta WABA and upsert into local templates table.
 * Provider-level fields are mirrored to every brand-local row on the same WABA + template name.
 */
export async function syncWhatsAppTemplatesForConnection(params: {
  tenantId: number;
  connectionId: number;
  requestingBrandId?: number | null;
}): Promise<{ synced: number; approved: number; templates: MetaMessageTemplate[] }> {
  if (params.requestingBrandId != null) {
    const { assertWhatsAppTemplateSyncPermitted } = await import(
      './channelConnectionBrandShareService'
    );
    await assertWhatsAppTemplateSyncPermitted({
      tenantId: params.tenantId,
      connectionId: params.connectionId,
      requestingBrandId: Number(params.requestingBrandId),
    });
  }

  const result = await query(
    `SELECT * FROM channel_connections
     WHERE id = $1 AND tenant_id = $2 AND channel_type = 'WHATSAPP'`,
    [params.connectionId, params.tenantId]
  );
  if (result.rows.length === 0) {
    throw Object.assign(new Error('WhatsApp bağlantısı bulunamadı'), { code: 'NOT_FOUND' });
  }
  const connection = result.rows[0];
  const ownerBrandId = Number(connection.brand_id);
  const creds = unpackWhatsAppCredentials(connection.encrypted_credentials);
  const config = parseWhatsAppSettings(connection.settings);
  const wabaId = config.wabaId;
  const remote = await fetchWabaMessageTemplates({
    accessToken: creds.accessToken,
    wabaId,
    apiVersion: config.apiVersion,
  });

  let synced = 0;
  let approved = 0;
  const now = new Date();

  for (const tpl of remote) {
    if (!tpl.name || !tpl.language) continue;
    if (String(tpl.status).toUpperCase() === 'APPROVED') approved += 1;

    const existingAny = await query(
      `SELECT id, library_key FROM templates
       WHERE tenant_id = $1
         AND channel_type = 'WHATSAPP'
         AND provider_template_name = $2
         AND provider_template_language = $3
         AND (
           provider_waba_id = $4
           OR (provider_waba_id IS NULL AND $4::text IS NOT NULL)
         )
       ORDER BY
         CASE WHEN brand_id = $5 THEN 0 ELSE 1 END,
         CASE WHEN provider_waba_id = $4 THEN 0 ELSE 1 END,
         id ASC
       LIMIT 1`,
      [params.tenantId, tpl.name, tpl.language, wabaId, ownerBrandId]
    );

    const approval = mapMetaStatusToApproval(tpl.status);
    const catalogHit = getReadyTemplateByProviderName(tpl.name);
    const libraryKey = existingAny.rows[0]?.library_key || catalogHit?.key || null;
    const rejectionReason =
      approval === 'REJECTED'
        ? humanizeWhatsAppTemplateRejection(tpl.rejectedReason)
        : null;
    const displayName = catalogHit ? catalogHit.displayName : `${tpl.name} (${tpl.language})`;
    const bodyText =
      Array.isArray(tpl.components)
        ? (tpl.components as any[])
            .filter((c) => String(c?.type || '').toUpperCase() === 'BODY')
            .map((c) => c.text)
            .filter(Boolean)
            .join('\n') || displayName
        : displayName;

    const componentsJson = JSON.stringify(
      buildProviderComponentsPayload({
        metaTemplateId: tpl.id,
        category: tpl.category,
        status: tpl.status,
        components: tpl.components,
        wabaId,
        rejectedReason: tpl.rejectedReason,
        qualityScore: tpl.qualityScore,
        lastSyncedAt: now.toISOString(),
      })
    );

    if (existingAny.rows[0]?.id) {
      await query(
        `UPDATE templates SET
           name = CASE WHEN brand_id = $1 THEN $2 ELSE name END,
           plain_text_content = CASE
             WHEN brand_id = $1 THEN COALESCE(NULLIF(plain_text_content, ''), $3)
             ELSE plain_text_content
           END,
           provider_approval_status = $4,
           provider_template_components = $5::jsonb,
           provider_waba_id = $6,
           channel_connection_id = $7,
           library_key = COALESCE(library_key, $8),
           provider_rejection_reason = $9,
           updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $10
           AND channel_type = 'WHATSAPP'
           AND provider_template_name = $11
           AND provider_template_language = $12
           AND (
             provider_waba_id = $6
             OR (provider_waba_id IS NULL AND $6::text IS NOT NULL)
           )`,
        [
          ownerBrandId,
          displayName,
          bodyText,
          approval,
          componentsJson,
          wabaId,
          params.connectionId,
          libraryKey,
          rejectionReason,
          params.tenantId,
          tpl.name,
          tpl.language,
        ]
      );
    } else {
      await query(
        `INSERT INTO templates (
           tenant_id, brand_id, name, content, channel_type, plain_text_content,
           provider_template_name, provider_template_language,
           provider_approval_status, provider_template_components, is_active, is_draft,
           provider_waba_id, channel_connection_id, library_key, provider_rejection_reason
         ) VALUES (
           $1,$2,$3,$4,'WHATSAPP',$4,$5,$6,$7,$8::jsonb,true,false,$9,$10,$11,$12
         )`,
        [
          params.tenantId,
          ownerBrandId,
          displayName,
          bodyText,
          tpl.name,
          tpl.language,
          approval,
          componentsJson,
          wabaId,
          params.connectionId,
          libraryKey,
          rejectionReason,
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
