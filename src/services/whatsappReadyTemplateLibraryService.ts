/**
 * Submit / list / refresh WhatsApp ready-template library installs per tenant WABA.
 * Never returns tokens or secrets.
 */

import { query } from '../config/database';
import { createWabaMessageTemplate } from './metaEmbeddedSignupService';
import {
  humanizeWhatsAppTemplateRejection,
  mapMetaStatusToApproval,
  syncWhatsAppTemplatesForConnection,
} from './whatsappTemplateSyncService';
import { unpackWhatsAppCredentials, parseWhatsAppSettings } from '../whatsapp/whatsappCredentials';
import {
  WHATSAPP_READY_TEMPLATE_CATALOG,
  WhatsAppReadyTemplateCatalogItem,
  buildCatalogPreview,
  countBodyPlaceholders,
  getReadyTemplateByKey,
} from '../whatsapp/whatsappReadyTemplateCatalog';

export type LibraryInstallSummary = {
  templateId: number;
  status: string;
  rejectionReason: string | null;
  providerTemplateName: string;
  channelConnectionId: number | null;
  canSend: boolean;
};

function publicInstallRow(row: any): LibraryInstallSummary {
  const status = String(row.provider_approval_status || 'UNKNOWN').toUpperCase();
  return {
    templateId: Number(row.id),
    status,
    rejectionReason:
      status === 'REJECTED'
        ? humanizeWhatsAppTemplateRejection(row.provider_rejection_reason) ||
          humanizeWhatsAppTemplateRejection(
            row.provider_template_components?.rejected_reason
          )
        : null,
    providerTemplateName: String(row.provider_template_name || ''),
    channelConnectionId: row.channel_connection_id != null ? Number(row.channel_connection_id) : null,
    canSend: status === 'APPROVED' && Boolean(row.provider_template_name) && row.is_active !== false,
  };
}

export async function loadActiveWhatsAppConnection(params: {
  tenantId: number;
  brandId: number;
  connectionId: number;
}) {
  const connectionResult = await query(
    `SELECT * FROM channel_connections
     WHERE id = $1
       AND tenant_id = $2
       AND brand_id = $3
       AND channel_type = 'WHATSAPP'
       AND status = 'ACTIVE'`,
    [params.connectionId, params.tenantId, params.brandId]
  );
  if (connectionResult.rows.length === 0) {
    throw Object.assign(
      new Error('Seçilen WhatsApp kanalı bulunamadı, pasif veya bu markaya ait değil'),
      { code: 'NO_ACTIVE_CONNECTION' }
    );
  }
  const connection = connectionResult.rows[0];
  const creds = unpackWhatsAppCredentials(connection.encrypted_credentials);
  const config = parseWhatsAppSettings(connection.settings);
  if (!config.wabaId || !creds.accessToken) {
    throw Object.assign(new Error('WhatsApp bağlantı kimlik bilgileri eksik'), {
      code: 'MISSING_CREDENTIALS',
    });
  }
  return { connection, creds, config, wabaId: config.wabaId as string };
}

export async function findLibraryInstall(params: {
  tenantId: number;
  wabaId: string;
  libraryKey: string;
}) {
  const result = await query(
    `SELECT *
     FROM templates
     WHERE tenant_id = $1
       AND channel_type = 'WHATSAPP'
       AND library_key = $2
       AND provider_waba_id = $3
     ORDER BY id ASC
     LIMIT 1`,
    [params.tenantId, params.libraryKey, params.wabaId]
  );
  return result.rows[0] || null;
}

export async function findInstallByProviderName(params: {
  tenantId: number;
  wabaId: string;
  providerName: string;
  language: string;
}) {
  const result = await query(
    `SELECT *
     FROM templates
     WHERE tenant_id = $1
       AND channel_type = 'WHATSAPP'
       AND provider_template_name = $2
       AND provider_template_language = $3
       AND provider_waba_id = $4
     ORDER BY id ASC
     LIMIT 1`,
    [params.tenantId, params.providerName, params.language, params.wabaId]
  );
  return result.rows[0] || null;
}

export function listCatalogPublic() {
  return WHATSAPP_READY_TEMPLATE_CATALOG.map((item) => ({
    key: item.key,
    displayName: item.displayName,
    description: item.description,
    providerName: item.providerName,
    category: item.category,
    language: item.language,
    bodyText: item.bodyText,
    variables: item.variables,
    preview: buildCatalogPreview(item.bodyText, item.variables.map((v) => v.example)),
  }));
}

export function buildPreview(bodyText: string, examples: string[]): string {
  return buildCatalogPreview(bodyText, examples);
}

export async function listLibraryWithInstalls(params: {
  tenantId: number;
  brandId?: number | null;
  connectionId?: number | null;
}) {
  const catalog = listCatalogPublic();
  let wabaId: string | null = null;
  let connectionId: number | null = null;

  if (params.connectionId && params.brandId) {
    try {
      const loaded = await loadActiveWhatsAppConnection({
        tenantId: params.tenantId,
        brandId: params.brandId,
        connectionId: params.connectionId,
      });
      wabaId = loaded.wabaId;
      connectionId = params.connectionId;
    } catch {
      wabaId = null;
    }
  }

  let installsByKey = new Map<string, any>();
  if (wabaId) {
    const result = await query(
      `SELECT *
       FROM templates
       WHERE tenant_id = $1
         AND channel_type = 'WHATSAPP'
         AND provider_waba_id = $2
         AND library_key IS NOT NULL`,
      [params.tenantId, wabaId]
    );
    for (const row of result.rows) {
      installsByKey.set(String(row.library_key), row);
    }
  }

  return {
    connectionId,
    wabaScoped: Boolean(wabaId),
    notice:
      'Bu şablon kendi WhatsApp hesabınız için Meta’ya bir kez gönderilir. Onaylandıktan sonra farklı müşterilere değişkenlerle tekrar tekrar gönderebilirsiniz.',
    conversationRule:
      'Müşteri konuşma başlatmadığında onaylı şablon gerekir.',
    items: catalog.map((item) => {
      const row = installsByKey.get(item.key);
      return {
        ...item,
        installation: row ? publicInstallRow(row) : null,
      };
    }),
  };
}

export async function submitReadyTemplate(params: {
  tenantId: number;
  userId: number;
  libraryKey: string;
  brandId: number;
  connectionId: number;
  bodyText?: string | null;
  examples?: string[] | null;
}) {
  const catalog = getReadyTemplateByKey(params.libraryKey);
  if (!catalog) {
    throw Object.assign(new Error('Hazır şablon bulunamadı'), { code: 'NOT_FOUND' });
  }

  const brand = await query(`SELECT id FROM brands WHERE id = $1 AND tenant_id = $2`, [
    params.brandId,
    params.tenantId,
  ]);
  if (brand.rows.length === 0) {
    throw Object.assign(new Error('Marka bulunamadı'), { code: 'NOT_FOUND' });
  }

  const { connection, creds, config, wabaId } = await loadActiveWhatsAppConnection({
    tenantId: params.tenantId,
    brandId: params.brandId,
    connectionId: params.connectionId,
  });

  const existing =
    (await findLibraryInstall({
      tenantId: params.tenantId,
      wabaId,
      libraryKey: catalog.key,
    })) ||
    (await findInstallByProviderName({
      tenantId: params.tenantId,
      wabaId,
      providerName: catalog.providerName,
      language: catalog.language,
    }));

  if (existing) {
    return {
      alreadyExists: true as const,
      installation: publicInstallRow(existing),
      message: 'Bu hazır şablon bu WhatsApp hesabında zaten kayıtlı.',
    };
  }

  const bodyText = String(params.bodyText || catalog.bodyText).trim();
  if (!bodyText) {
    throw Object.assign(new Error('Şablon metni zorunludur'), { code: 'BAD_REQUEST' });
  }

  const bodyChanged = bodyText !== catalog.bodyText;
  const placeholderCount = countBodyPlaceholders(bodyText);
  const defaultExamples = catalog.variables
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((v) => v.example);
  let examples = Array.isArray(params.examples)
    ? params.examples.map((v) => String(v ?? '').trim())
    : defaultExamples;
  if (examples.length < placeholderCount) {
    examples = [
      ...examples,
      ...defaultExamples.slice(examples.length, placeholderCount),
    ];
  }
  examples = examples.slice(0, Math.max(placeholderCount, 0));
  if (placeholderCount > 0 && examples.some((e) => !e)) {
    throw Object.assign(new Error('Tüm değişken örnekleri doldurulmalıdır'), {
      code: 'BAD_REQUEST',
    });
  }

  let created;
  try {
    created = await createWabaMessageTemplate({
      accessToken: creds.accessToken,
      wabaId,
      name: catalog.providerName,
      language: catalog.language,
      category: catalog.category,
      bodyText,
      bodyExamples: placeholderCount > 0 ? examples : undefined,
      apiVersion: config.apiVersion,
    });
  } catch (metaErr: any) {
    const failure = metaErr?.metaFailure;
    const message =
      failure && typeof failure === 'object'
        ? String(metaErr?.message || 'WhatsApp şablonu oluşturulamadı')
        : String(metaErr?.message || 'WhatsApp şablonu oluşturulamadı');
    throw Object.assign(new Error(message), {
      code: 'META_CREATE_FAILED',
      metaFailure: failure || null,
    });
  }

  let approval = mapMetaStatusToApproval(created.status || 'PENDING');
  if (approval === 'UNKNOWN') approval = 'PENDING';

  const componentsPayload = {
    meta_template_id: created.id,
    category: created.category || catalog.category,
    status: String(created.status || 'PENDING').toUpperCase(),
    components: [
      {
        type: 'BODY',
        text: bodyText,
        ...(examples.length
          ? { example: { body_text: [examples] } }
          : {}),
      },
    ],
    waba_id: wabaId,
    created_via: 'READY_LIBRARY',
    library_key: catalog.key,
    body_customized: bodyChanged,
    last_synced_at: new Date().toISOString(),
  };

  const variablesJson = JSON.stringify(
    catalog.variables.map((v) => ({
      name: v.key,
      label: v.label,
      index: v.index,
      example: examples[v.index - 1] || v.example,
    }))
  );

  const inserted = await query(
    `INSERT INTO templates
      (name, content, tenant_id, created_by, is_shared, brand_id, channel_type,
       plain_text_content, variables, is_active, is_draft, template_kind,
       provider_template_name, provider_template_language, provider_approval_status,
       provider_template_components, provider_waba_id, channel_connection_id,
       library_key, description)
     VALUES
      ($1,$2,$3,$4,true,$5,'WHATSAPP',$2,$6::jsonb,true,false,'INDIVIDUAL',
       $7,$8,$9,$10::jsonb,$11,$12,$13,$14)
     RETURNING *`,
    [
      catalog.displayName,
      bodyText,
      params.tenantId,
      params.userId,
      params.brandId,
      variablesJson,
      catalog.providerName,
      catalog.language,
      approval,
      JSON.stringify(componentsPayload),
      wabaId,
      connection.id,
      catalog.key,
      catalog.description,
    ]
  );

  return {
    alreadyExists: false as const,
    bodyCustomized: bodyChanged,
    installation: publicInstallRow(inserted.rows[0]),
    message:
      'Şablon WhatsApp hesabınıza gönderildi. Meta onayından sonra gönderimde kullanabilirsiniz.',
  };
}

export async function refreshLibraryTemplate(params: {
  tenantId: number;
  brandId: number;
  connectionId: number;
  libraryKey: string;
}) {
  const catalog = getReadyTemplateByKey(params.libraryKey);
  if (!catalog) {
    throw Object.assign(new Error('Hazır şablon bulunamadı'), { code: 'NOT_FOUND' });
  }

  await loadActiveWhatsAppConnection({
    tenantId: params.tenantId,
    brandId: params.brandId,
    connectionId: params.connectionId,
  });

  const sync = await syncWhatsAppTemplatesForConnection({
    tenantId: params.tenantId,
    connectionId: params.connectionId,
  });

  const { wabaId } = await loadActiveWhatsAppConnection({
    tenantId: params.tenantId,
    brandId: params.brandId,
    connectionId: params.connectionId,
  });

  const row =
    (await findLibraryInstall({
      tenantId: params.tenantId,
      wabaId,
      libraryKey: catalog.key,
    })) ||
    (await findInstallByProviderName({
      tenantId: params.tenantId,
      wabaId,
      providerName: catalog.providerName,
      language: catalog.language,
    }));

  return {
    synced: sync.synced,
    approved: sync.approved,
    installation: row ? publicInstallRow(row) : null,
  };
}

export type { WhatsAppReadyTemplateCatalogItem };
