/**
 * Create custom (non-library) WhatsApp templates on Meta for a tenant connection.
 */

import { query } from '../config/database';
import {
  createWabaMessageTemplate,
  type WabaTemplateButtonInput,
} from './metaEmbeddedSignupService';
import { mapMetaStatusToApproval } from './whatsappTemplateSyncService';
import {
  findInstallByProviderName,
  loadActiveWhatsAppConnection,
} from './whatsappReadyTemplateLibraryService';
import {
  bodyEndsWithPlaceholder,
  bodyStartsWithPlaceholder,
  countBodyPlaceholders,
  listBodyPlaceholderOrder,
} from '../whatsapp/whatsappReadyTemplateCatalog';
import {
  isValidWhatsAppTemplateName,
  isWhatsAppTemplateCategory,
  normalizeWhatsAppTemplateName,
} from '../utils/whatsappTemplateName';

export type CustomTemplateVariableInput = {
  index: number;
  key?: string;
  label?: string;
  example: string;
};

export type CustomWebsiteButtonInput = {
  text: string;
  url: string;
};

export type SubmitCustomWhatsAppTemplateParams = {
  tenantId: number;
  userId: number;
  brandId: number;
  connectionId: number;
  displayName: string;
  bodyText: string;
  category: string;
  language?: string;
  examples?: string[] | null;
  variables?: CustomTemplateVariableInput[] | null;
  websiteButton?: CustomWebsiteButtonInput | null;
  includeOptOutQuickReply?: boolean;
  providerTemplateName?: string | null;
};

function validateBodyRules(bodyText: string): string | null {
  const text = String(bodyText || '').trim();
  if (!text) return 'Mesaj metni zorunludur';
  if (bodyStartsWithPlaceholder(text)) {
    return 'Mesaj metni bir değişkenle başlayamaz';
  }
  if (bodyEndsWithPlaceholder(text)) {
    return 'Mesaj metni bir değişkenle bitemez; sonuna kısa bir cümle ekleyin';
  }
  const order = listBodyPlaceholderOrder(text);
  const count = countBodyPlaceholders(text);
  if (order.length !== count) {
    return 'Değişken numaraları 1’den başlayıp kesintisiz ilerlemelidir';
  }
  for (let i = 0; i < order.length; i++) {
    if (order[i] !== i + 1) {
      return 'Değişken numaraları 1’den başlayıp kesintisiz ilerlemelidir';
    }
  }
  return null;
}

function resolveExamples(bodyText: string, examples?: string[] | null): string[] {
  const count = countBodyPlaceholders(bodyText);
  if (count === 0) return [];
  let list = Array.isArray(examples)
    ? examples.map((v) => String(v ?? '').trim())
    : [];
  if (list.length < count) {
    list = [...list, ...Array(count - list.length).fill('')];
  }
  return list.slice(0, count);
}

async function resolveUniqueProviderName(params: {
  tenantId: number;
  wabaId: string;
  language: string;
  baseName: string;
}): Promise<string> {
  let candidate = params.baseName;
  let suffix = 0;
  while (
    await findInstallByProviderName({
      tenantId: params.tenantId,
      wabaId: params.wabaId,
      providerName: candidate,
      language: params.language,
    })
  ) {
    suffix += 1;
    candidate = `${params.baseName}_${suffix}`.replace(/_+/g, '_').slice(0, 512);
    if (!isValidWhatsAppTemplateName(candidate)) {
      throw Object.assign(new Error('Benzersiz şablon adı üretilemedi'), { code: 'BAD_REQUEST' });
    }
  }
  return candidate;
}

function buildButtons(params: SubmitCustomWhatsAppTemplateParams): WabaTemplateButtonInput[] {
  const buttons: WabaTemplateButtonInput[] = [];
  const site = params.websiteButton;
  if (site && String(site.text || '').trim() && String(site.url || '').trim()) {
    buttons.push({
      type: 'URL',
      text: String(site.text).trim().slice(0, 25),
      url: String(site.url).trim(),
    });
  }
  if (params.includeOptOutQuickReply) {
    buttons.push({
      type: 'QUICK_REPLY',
      text: 'Mesaj almak istemiyorum',
    });
  }
  return buttons.slice(0, 3);
}

export async function submitCustomWhatsAppTemplate(params: SubmitCustomWhatsAppTemplateParams) {
  if (!isWhatsAppTemplateCategory(params.category)) {
    throw Object.assign(new Error('Geçersiz kategori'), { code: 'BAD_REQUEST' });
  }
  const category = String(params.category).toUpperCase();
  const bodyText = String(params.bodyText || '').trim();
  const bodyErr = validateBodyRules(bodyText);
  if (bodyErr) {
    throw Object.assign(new Error(bodyErr), { code: 'BAD_REQUEST' });
  }

  const placeholderCount = countBodyPlaceholders(bodyText);
  const examples = resolveExamples(bodyText, params.examples);
  if (placeholderCount > 0 && examples.some((e) => !e)) {
    throw Object.assign(new Error('Her değişken için örnek değer zorunludur'), {
      code: 'BAD_REQUEST',
    });
  }

  const displayName = String(params.displayName || '').trim();
  if (!displayName) {
    throw Object.assign(new Error('Şablon başlığı zorunludur'), { code: 'BAD_REQUEST' });
  }

  const language =
    String(params.language || 'tr')
      .trim()
      .toLowerCase() || 'tr';

  const { connection, creds, config, wabaId } = await loadActiveWhatsAppConnection({
    tenantId: params.tenantId,
    brandId: params.brandId,
    connectionId: params.connectionId,
  });

  const baseProviderName = normalizeWhatsAppTemplateName(
    String(params.providerTemplateName || displayName)
  );
  if (!isValidWhatsAppTemplateName(baseProviderName)) {
    throw Object.assign(
      new Error('Şablon adı geçersiz; yalnızca harf, rakam ve alt çizgi kullanılabilir'),
      { code: 'BAD_REQUEST' }
    );
  }

  const providerName = await resolveUniqueProviderName({
    tenantId: params.tenantId,
    wabaId,
    language,
    baseName: baseProviderName,
  });

  const buttons = buildButtons(params);

  let created;
  try {
    created = await createWabaMessageTemplate({
      accessToken: creds.accessToken,
      wabaId,
      name: providerName,
      language,
      category,
      bodyText,
      bodyExamples: placeholderCount > 0 ? examples : undefined,
      buttons: buttons.length ? buttons : undefined,
      apiVersion: config.apiVersion,
    });
  } catch (metaErr: any) {
    throw Object.assign(
      new Error(String(metaErr?.message || 'WhatsApp şablonu oluşturulamadı')),
      { code: 'META_CREATE_FAILED', metaFailure: metaErr?.metaFailure || null }
    );
  }

  let approval = mapMetaStatusToApproval(created.status || 'PENDING');
  if (approval === 'UNKNOWN') approval = 'PENDING';

  const metaComponents: Record<string, unknown>[] = [
    {
      type: 'BODY',
      text: bodyText,
      ...(examples.length ? { example: { body_text: [examples] } } : {}),
    },
  ];
  if (buttons.length) {
    metaComponents.push({ type: 'BUTTONS', buttons });
  }

  const variablesJson = JSON.stringify(
    (Array.isArray(params.variables) && params.variables.length
      ? params.variables
      : examples.map((example, i) => ({
          index: i + 1,
          key: `var_${i + 1}`,
          label: `Değişken ${i + 1}`,
          example,
        }))
    ).map((v: CustomTemplateVariableInput, i: number) => {
      const idx = Number(v.index ?? i + 1);
      return {
        index: idx,
        key: v.key || `var_${idx}`,
        label: v.label || `Değişken ${idx}`,
        example: String(v.example ?? examples[idx - 1] ?? '').trim(),
      };
    })
  );

  const componentsPayload = {
    meta_template_id: created.id,
    category: created.category || category,
    status: String(created.status || 'PENDING').toUpperCase(),
    components: metaComponents,
    waba_id: wabaId,
    created_via: 'CUSTOM',
    last_synced_at: new Date().toISOString(),
  };

  const inserted = await query(
    `INSERT INTO templates
      (name, content, tenant_id, created_by, is_shared, brand_id, channel_type,
       plain_text_content, variables, is_active, is_draft, template_kind,
       provider_template_name, provider_template_language, provider_approval_status,
       provider_template_components, provider_waba_id, channel_connection_id,
       description)
     VALUES
      ($1,$2,$3,$4,true,$5,'WHATSAPP',$2,$6::jsonb,true,false,'INDIVIDUAL',
       $7,$8,$9,$10::jsonb,$11,$12,$13)
     RETURNING *`,
    [
      displayName,
      bodyText,
      params.tenantId,
      params.userId,
      params.brandId,
      variablesJson,
      providerName,
      language,
      approval,
      JSON.stringify(componentsPayload),
      wabaId,
      connection.id,
      null,
    ]
  );

  return {
    template: inserted.rows[0],
    providerName,
    message:
      'Şablon WhatsApp hesabınıza gönderildi. Meta onayından sonra gönderimde kullanabilirsiniz.',
  };
}
