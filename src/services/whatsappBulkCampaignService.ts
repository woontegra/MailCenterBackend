import * as XLSX from 'xlsx';
import { getClient, query } from '../config/database';
import { normalizePhone, getTenantDefaultCountryCode } from '../utils/contactNormalize';
import { checkRecipientEligibility } from '../utils/recipientEligibility';
import { renderTemplateContent, extractTemplateVariables } from '../utils/templateRenderer';
import {
  humanizeCampaignRecipientError,
  humanizeRecipientBlock,
} from '../utils/humanizeEligibility';
import { resolveEligibleWhatsAppSenderIdentity } from '../utils/senderIdentityAccess';
import { parseRecipientFile } from './campaignImportService';
import { enqueueCampaignDispatch } from '../queues/mailQueue';
import { sanitizeOutboundErrorMessage } from '../config/outboundQueue';
import { getCampaignForTenant, pauseCampaign, cancelCampaign, resumeCampaign } from './campaignService';
import {
  loadContactsFromLists,
  enrichCampaignsWithListMeta,
} from './contactListService';

export type VariableMapping = Record<string, string>;

export type BulkRecipientInput = {
  row_number?: number;
  phone?: string;
  contact_id?: number;
  display_name?: string;
  fields?: Record<string, string>;
};

export type BulkSummary = {
  total: number;
  sendable: number;
  invalid: number;
  duplicate: number;
  no_permission: number;
  missing_variable: number;
  estimated_sends: number;
};

export type ResolvedBulkRecipient = {
  row_number?: number;
  phone?: string;
  phone_normalized?: string;
  contact_id?: number | null;
  display_name?: string;
  personalisation: Record<string, string>;
  category: 'sendable' | 'invalid' | 'duplicate' | 'no_permission' | 'missing_variable';
  reason?: string;
};

const BUILTIN_FIELD_KEYS = ['ad', 'soyad', 'tam_ad', 'firma', 'telefon', 'email'] as const;

function templateMarketingCategory(template: any): string {
  const comp = template?.provider_template_components;
  if (comp && typeof comp === 'object' && !Array.isArray(comp)) {
    return String((comp as any).category || '').toUpperCase();
  }
  return '';
}

function declaredTemplateVariables(template: any): string[] {
  const fromDefs = Array.isArray(template?.variables)
    ? template.variables
        .map((v: any) => (typeof v === 'string' ? v : v?.name))
        .filter(Boolean)
    : [];
  if (fromDefs.length > 0) return fromDefs.map(String);
  return extractTemplateVariables(template?.plain_text_content || template?.content || '');
}

function contactDisplayName(c: {
  first_name?: string | null;
  last_name?: string | null;
  company_name?: string | null;
}) {
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
  return name || c.company_name || 'İsimsiz kişi';
}

function buildBuiltinFields(params: {
  first_name?: string | null;
  last_name?: string | null;
  company_name?: string | null;
  email?: string | null;
  phone?: string | null;
}) {
  const ad = String(params.first_name || '').trim();
  const soyad = String(params.last_name || '').trim();
  const tamAd = [ad, soyad].filter(Boolean).join(' ').trim();
  return {
    ad,
    soyad,
    tam_ad: tamAd,
    firma: String(params.company_name || '').trim(),
    telefon: String(params.phone || '').trim(),
    email: String(params.email || '').trim(),
  };
}

function applyVariableMapping(
  mapping: VariableMapping,
  fields: Record<string, string>
): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const [varName, fieldKey] of Object.entries(mapping)) {
    const val = String(fields[fieldKey] ?? '').trim();
    values[varName] = val;
    if (!val) missing.push(varName);
  }
  return { values, missing };
}

export function normalizeTurkishPastePhone(line: string): ReturnType<typeof normalizePhone> {
  return normalizePhone({ value: line, countryCode: '90' });
}

export async function assertMarketingWhatsAppTemplate(params: {
  tenantId: number;
  brandId: number;
  templateId: number;
  channelConnectionId: number;
}) {
  const tplRes = await query(
    `SELECT t.*, cc.settings AS connection_settings
     FROM templates t
     JOIN channel_connections cc
       ON cc.id = $3 AND cc.tenant_id = t.tenant_id
     WHERE t.id = $1 AND t.tenant_id = $2
       AND t.channel_type = 'WHATSAPP'
       AND COALESCE(t.is_active, true) = true`,
    [params.templateId, params.tenantId, params.channelConnectionId]
  );
  if (tplRes.rows.length === 0) {
    throw Object.assign(new Error('Şablon bulunamadı'), { status: 404 });
  }
  const tpl = tplRes.rows[0];
  if (tpl.brand_id && Number(tpl.brand_id) !== Number(params.brandId)) {
    throw Object.assign(new Error('Şablon seçilen markaya ait değil'), { status: 400 });
  }
  if (String(tpl.provider_approval_status || '').toUpperCase() !== 'APPROVED') {
    throw Object.assign(new Error('Yalnızca onaylı şablonlar kullanılabilir'), { status: 400 });
  }
  if (templateMarketingCategory(tpl) !== 'MARKETING') {
    throw Object.assign(new Error('Toplu gönderim için yalnızca pazarlama şablonları kullanılabilir'), {
      status: 400,
    });
  }
  const wabaId = String((tpl.connection_settings as any)?.waba_id || '').trim();
  const tplWaba = String(tpl.provider_waba_id || '').trim();
  if (wabaId && tplWaba && tplWaba !== wabaId) {
    throw Object.assign(new Error('Şablon seçilen WhatsApp hattıyla uyuşmuyor'), { status: 400 });
  }

  const { brandCanUseConnection } = await import('./channelConnectionBrandShareService');
  const connectionAllowed = await brandCanUseConnection(
    params.tenantId,
    params.brandId,
    params.channelConnectionId
  );
  if (!connectionAllowed) {
    throw Object.assign(new Error('WhatsApp hattı bu markada kullanılamaz'), { status: 403 });
  }

  return tpl;
}

async function loadContactRows(
  tenantId: number,
  contactIds: number[]
): Promise<BulkRecipientInput[]> {
  if (contactIds.length === 0) return [];
  const res = await query(
    `SELECT c.id, c.first_name, c.last_name, c.company_name,
            cp.value AS phone_value, cp.normalized_value AS phone_normalized,
            cp.channel_type,
            (
              SELECT cp2.normalized_value
              FROM contact_points cp2
              WHERE cp2.tenant_id = c.tenant_id AND cp2.contact_id = c.id
                AND cp2.channel_type = 'EMAIL' AND cp2.is_active = true
              ORDER BY cp2.is_primary DESC, cp2.id
              LIMIT 1
            ) AS email_normalized
     FROM contacts c
     JOIN LATERAL (
       SELECT value, normalized_value, channel_type
       FROM contact_points
       WHERE tenant_id = c.tenant_id AND contact_id = c.id AND is_active = true
         AND channel_type IN ('WHATSAPP', 'SMS')
       ORDER BY
         CASE channel_type WHEN 'WHATSAPP' THEN 0 ELSE 1 END,
         is_primary DESC,
         id
       LIMIT 1
     ) cp ON true
     WHERE c.tenant_id = $1 AND c.id = ANY($2::int[]) AND c.status = 'ACTIVE'`,
    [tenantId, contactIds]
  );

  return res.rows.map((row: any) => {
    const phone = row.phone_normalized || row.phone_value || '';
    const builtins = buildBuiltinFields({
      first_name: row.first_name,
      last_name: row.last_name,
      company_name: row.company_name,
      email: row.email_normalized,
      phone,
    });
    return {
      contact_id: Number(row.id),
      phone,
      display_name: contactDisplayName(row),
      fields: builtins,
    };
  });
}

function parsePastePhones(paste: string): BulkRecipientInput[] {
  const lines = paste
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.map((line, idx) => ({
    row_number: idx + 1,
    phone: line,
    fields: { telefon: line },
  }));
}

export async function resolveBulkRecipients(params: {
  tenantId: number;
  brandId: number;
  template: any;
  variableMapping: VariableMapping;
  inputs: BulkRecipientInput[];
}): Promise<{ recipients: ResolvedBulkRecipient[]; summary: BulkSummary }> {
  const seen = new Set<string>();
  const recipients: ResolvedBulkRecipient[] = [];
  const summary: BulkSummary = {
    total: params.inputs.length,
    sendable: 0,
    invalid: 0,
    duplicate: 0,
    no_permission: 0,
    missing_variable: 0,
    estimated_sends: 0,
  };

  const countryCode =
    (await getTenantDefaultCountryCode(params.tenantId)) || '90';

  for (const input of params.inputs) {
    let phoneRaw = String(input.phone || input.fields?.telefon || '').trim();
    if (!phoneRaw && input.contact_id) {
      phoneRaw = String(input.fields?.telefon || '').trim();
    }

    const base: ResolvedBulkRecipient = {
      row_number: input.row_number,
      contact_id: input.contact_id ?? null,
      display_name: input.display_name,
      personalisation: {},
      category: 'invalid',
    };

    if (!phoneRaw) {
      base.reason = humanizeRecipientBlock('INVALID_ADDRESS');
      summary.invalid += 1;
      recipients.push(base);
      continue;
    }

    const normalized =
      input.contact_id && phoneRaw.startsWith('+')
        ? normalizePhone({ value: phoneRaw, countryCode })
        : normalizeTurkishPastePhone(phoneRaw);

    if (normalized.ok === false) {
      base.phone = phoneRaw;
      base.reason = humanizeRecipientBlock('INVALID_ADDRESS', normalized.error);
      summary.invalid += 1;
      recipients.push(base);
      continue;
    }

    base.phone = normalized.value;
    base.phone_normalized = normalized.normalized;

    if (seen.has(normalized.normalized)) {
      base.category = 'duplicate';
      base.reason = humanizeRecipientBlock('DUPLICATE');
      summary.duplicate += 1;
      recipients.push(base);
      continue;
    }
    seen.add(normalized.normalized);

    const eligibility = await checkRecipientEligibility({
      tenantId: params.tenantId,
      channelType: 'WHATSAPP',
      value: normalized.normalized,
      brandId: params.brandId,
      countryCode,
      strictPreference: true,
    });

    if (!eligibility.eligible) {
      base.category = 'no_permission';
      base.reason = humanizeRecipientBlock(eligibility.code, eligibility.reason);
      summary.no_permission += 1;
      recipients.push(base);
      continue;
    }

    base.contact_id = eligibility.contactId ?? input.contact_id ?? null;
    const fields = {
      ...buildBuiltinFields({
        first_name: input.fields?.ad,
        last_name: input.fields?.soyad,
        company_name: input.fields?.firma,
        email: input.fields?.email,
        phone: normalized.value,
      }),
      ...(input.fields || {}),
      telefon: normalized.value,
    };

    const { values, missing } = applyVariableMapping(params.variableMapping, fields);
    base.personalisation = values;

    if (missing.length > 0) {
      base.category = 'missing_variable';
      base.reason = humanizeRecipientBlock(
        'MISSING_VARIABLE',
        `Eksik alan: ${missing.join(', ')}`
      );
      summary.missing_variable += 1;
      recipients.push(base);
      continue;
    }

    const rendered = renderTemplateContent({
      subject: '',
      htmlContent: '',
      plainTextContent:
        params.template.plain_text_content || params.template.content || '',
      variables: params.template.variables || [],
      values,
    });
    if (rendered.missingRequired.length > 0) {
      base.category = 'missing_variable';
      base.reason = humanizeRecipientBlock(
        'MISSING_VARIABLE',
        `Eksik alan: ${rendered.missingRequired.join(', ')}`
      );
      summary.missing_variable += 1;
      recipients.push(base);
      continue;
    }

    base.category = 'sendable';
    summary.sendable += 1;
    recipients.push(base);
  }

  summary.estimated_sends = summary.sendable;
  return { recipients, summary };
}

export async function previewWhatsAppBulkCampaign(params: {
  tenantId: number;
  brandId: number;
  channelConnectionId: number;
  templateId: number;
  variableMapping: VariableMapping;
  contactIds?: number[];
  listIds?: number[];
  phonesPaste?: string;
  rows?: BulkRecipientInput[];
}) {
  const template = await assertMarketingWhatsAppTemplate({
    tenantId: params.tenantId,
    brandId: params.brandId,
    templateId: params.templateId,
    channelConnectionId: params.channelConnectionId,
  });

  const declared = declaredTemplateVariables(template);
  for (const v of declared) {
    if (!params.variableMapping[v]) {
      throw Object.assign(new Error(`"${v}" değişkeni için eşleme gerekli`), { status: 400 });
    }
  }

  let inputs: BulkRecipientInput[] = [];
  if (params.rows?.length) {
    inputs = params.rows;
  } else if (params.listIds?.length) {
    inputs = await loadContactsFromLists(params.tenantId, params.listIds);
  } else if (params.contactIds?.length) {
    inputs = await loadContactRows(params.tenantId, params.contactIds);
  } else if (params.phonesPaste?.trim()) {
    inputs = parsePastePhones(params.phonesPaste);
  }

  if (inputs.length === 0) {
    throw Object.assign(new Error('En az bir alıcı gerekli'), { status: 400 });
  }
  if (inputs.length > 5000) {
    throw Object.assign(new Error('En fazla 5000 alıcı işlenebilir'), { status: 400 });
  }

  const resolved = await resolveBulkRecipients({
    tenantId: params.tenantId,
    brandId: params.brandId,
    template,
    variableMapping: params.variableMapping,
    inputs,
  });

  const samples = resolved.recipients
    .filter((r) => r.category === 'sendable')
    .slice(0, 3)
    .map((r) => {
      const rendered = renderTemplateContent({
        subject: '',
        htmlContent: '',
        plainTextContent: template.plain_text_content || template.content || '',
        variables: template.variables || [],
        values: r.personalisation,
      });
      return {
        phone: r.phone,
        display_name: r.display_name,
        message: rendered.plainTextContent,
      };
    });

  return {
    summary: resolved.summary,
    recipients: resolved.recipients.map((r) => ({
      row_number: r.row_number,
      phone: r.phone,
      display_name: r.display_name,
      category: r.category,
      reason: r.reason,
    })),
    input_rows: inputs,
    sample_previews: samples,
    template_variables: declared,
    builtin_fields: [...BUILTIN_FIELD_KEYS],
  };
}

export async function previewWhatsAppBulkImport(params: {
  tenantId: number;
  brandId: number;
  channelConnectionId: number;
  templateId: number;
  variableMapping: VariableMapping;
  file: { originalname: string; buffer: Buffer };
  mapping: Record<string, string>;
}) {
  const phoneColumn = String(params.mapping.phone || params.mapping.telefon || '').trim();
  if (!phoneColumn) {
    throw Object.assign(new Error('Telefon kolonu eşlemesi zorunludur'), { status: 400 });
  }

  const parsed = parseRecipientFile(params.file);
  const rows: BulkRecipientInput[] = parsed.rows.map((row, idx) => {
    const fields: Record<string, string> = {};
    for (const [header, val] of Object.entries(row)) {
      fields[header] = String(val ?? '').trim();
    }
    for (const [key, header] of Object.entries(params.mapping)) {
      if (!header || key === 'phone' || key === 'telefon') continue;
      fields[key] = String(row[header] ?? '').trim();
    }
    const displayHeader = params.mapping.display_name || params.mapping.ad_soyad;
    const displayName = displayHeader ? String(row[displayHeader] ?? '').trim() : '';
    const phone = String(row[phoneColumn] ?? '').trim();
    if (displayName && !fields.ad && !fields.tam_ad) {
      const parts = displayName.split(/\s+/);
      fields.ad = parts[0] || '';
      fields.soyad = parts.slice(1).join(' ');
      fields.tam_ad = displayName;
    }
    fields.telefon = phone;
    return {
      row_number: idx + 2,
      phone,
      display_name: displayName || undefined,
      fields,
    };
  });

  return previewWhatsAppBulkCampaign({
    tenantId: params.tenantId,
    brandId: params.brandId,
    channelConnectionId: params.channelConnectionId,
    templateId: params.templateId,
    variableMapping: params.variableMapping,
    rows,
  });
}

export async function launchWhatsAppBulkCampaign(params: {
  tenantId: number;
  userId: number;
  name: string;
  brandId: number;
  channelConnectionId: number;
  senderIdentityId: number;
  templateId: number;
  variableMapping: VariableMapping;
  contactIds?: number[];
  listIds?: number[];
  phonesPaste?: string;
  rows?: BulkRecipientInput[];
}) {
  const campaignName = String(params.name || '').trim();
  if (!campaignName) throw Object.assign(new Error('Kampanya adı gerekli'), { status: 400 });

  const brandOk = await query(`SELECT id FROM brands WHERE id = $1 AND tenant_id = $2`, [
    params.brandId,
    params.tenantId,
  ]);
  if (brandOk.rows.length === 0) {
    throw Object.assign(new Error('Marka bulunamadı'), { status: 404 });
  }

  const resolvedSender = await resolveEligibleWhatsAppSenderIdentity(
    params.senderIdentityId,
    params.tenantId,
    params.brandId
  );
  if (!resolvedSender) {
    throw Object.assign(new Error('Aktif WhatsApp göndericisi bulunamadı'), { status: 400 });
  }
  if (Number(resolvedSender.channel_connection_id) !== Number(params.channelConnectionId)) {
    throw Object.assign(new Error('Gönderici seçilen hat ile uyuşmuyor'), { status: 400 });
  }

  const template = await assertMarketingWhatsAppTemplate({
    tenantId: params.tenantId,
    brandId: params.brandId,
    templateId: params.templateId,
    channelConnectionId: params.channelConnectionId,
  });

  let inputs: BulkRecipientInput[] = [];
  if (params.rows?.length) inputs = params.rows;
  else if (params.listIds?.length) {
    inputs = await loadContactsFromLists(params.tenantId, params.listIds);
  } else if (params.contactIds?.length) {
    inputs = await loadContactRows(params.tenantId, params.contactIds);
  } else if (params.phonesPaste?.trim()) {
    inputs = parsePastePhones(params.phonesPaste);
  }
  if (inputs.length === 0) {
    throw Object.assign(new Error('Gönderilecek alıcı bulunamadı'), { status: 400 });
  }

  const resolved = await resolveBulkRecipients({
    tenantId: params.tenantId,
    brandId: params.brandId,
    template,
    variableMapping: params.variableMapping,
    inputs,
  });

  if (resolved.summary.sendable === 0) {
    throw Object.assign(new Error('Gönderilebilir alıcı bulunamadı'), {
      status: 400,
      summary: resolved.summary,
    });
  }

  const client = await getClient();
  let campaignId = 0;
  try {
    await client.query('BEGIN');

    const campaignRes = await client.query(
      `INSERT INTO campaigns (
         tenant_id, brand_id, name, template_id, sender_identity_id,
         status, channel_type, channel_connection_id,
         recipient_count, sent_count, failed_count,
         audience_config, recipient_summary, created_by, started_at
       ) VALUES (
         $1,$2,$3,$4,$5,'QUEUED','WHATSAPP',$6,$7,0,0,$8::jsonb,$9::jsonb,$10,CURRENT_TIMESTAMP
       ) RETURNING id`,
      [
        params.tenantId,
        params.brandId,
        campaignName,
        params.templateId,
        params.senderIdentityId,
        params.channelConnectionId,
        resolved.recipients.length,
        JSON.stringify({
          source: params.rows?.length
            ? 'import'
            : params.listIds?.length
              ? 'lists'
              : params.contactIds?.length
                ? 'contacts'
                : 'paste',
          list_ids: params.listIds || [],
          variable_mapping: params.variableMapping,
        }),
        JSON.stringify(resolved.summary),
        params.userId,
      ]
    );
    campaignId = Number(campaignRes.rows[0].id);

    for (const r of resolved.recipients) {
      const status = r.category === 'sendable' ? 'PENDING' : 'SKIPPED';
      await client.query(
        `INSERT INTO campaign_recipients (
           campaign_id, tenant_id, contact_id,
           phone, phone_normalized, display_name,
           personalisation_data, status, skip_reason, last_error, source
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)
         ON CONFLICT (campaign_id, phone_normalized) WHERE phone_normalized IS NOT NULL DO NOTHING`,
        [
          campaignId,
          params.tenantId,
          r.contact_id,
          r.phone || null,
          r.phone_normalized || null,
          r.display_name || null,
          JSON.stringify(r.personalisation),
          status,
          r.category !== 'sendable' ? r.category : null,
          r.category !== 'sendable' ? r.reason : null,
          params.listIds?.length ? 'lists' : params.contactIds?.length ? 'contacts' : params.rows?.length ? 'import' : 'paste',
        ]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await enqueueCampaignDispatch(campaignId, params.tenantId);

  return getCampaignForTenant(params.tenantId, campaignId);
}

export async function listWhatsAppCampaigns(
  tenantId: number,
  params?: { brand_id?: number; limit?: number }
) {
  const values: unknown[] = [tenantId];
  let sql = `
    SELECT c.*, b.name AS brand_name, t.name AS template_name,
           t.provider_template_name, t.provider_template_language
    FROM campaigns c
    LEFT JOIN brands b ON b.id = c.brand_id AND b.tenant_id = c.tenant_id
    LEFT JOIN templates t ON t.id = c.template_id AND t.tenant_id = c.tenant_id
    WHERE c.tenant_id = $1 AND c.channel_type = 'WHATSAPP'
  `;
  if (params?.brand_id) {
    values.push(params.brand_id);
    sql += ` AND c.brand_id = $${values.length}`;
  }
  sql += ' ORDER BY c.created_at DESC';
  if (params?.limit) {
    values.push(params.limit);
    sql += ` LIMIT $${values.length}`;
  }
  const result = await query(sql, values);
  return enrichCampaignsWithListMeta(tenantId, result.rows);
}

export async function listWhatsAppCampaignRecipients(
  tenantId: number,
  campaignId: number,
  limit = 100,
  offset = 0
) {
  const campaign = await getCampaignForTenant(tenantId, campaignId);
  if (!campaign || String(campaign.channel_type || '').toUpperCase() !== 'WHATSAPP') {
    return null;
  }
  const result = await query(
    `SELECT id, phone, phone_normalized, display_name, status, skip_reason,
            last_error, sent_at, queued_at, outbound_message_id
     FROM campaign_recipients
     WHERE campaign_id = $1 AND tenant_id = $2
     ORDER BY id
     LIMIT $3 OFFSET $4`,
    [campaignId, tenantId, limit, offset]
  );
  return result.rows.map((row: any) => ({
    ...row,
    last_error: row.last_error ? humanizeCampaignRecipientError(row.last_error) : null,
    status_label: mapRecipientStatusLabel(row.status, row.skip_reason),
  }));
}

function mapRecipientStatusLabel(status: string, skipReason?: string | null): string {
  const st = String(status || '').toUpperCase();
  if (st === 'SENT') return 'Gönderildi';
  if (st === 'FAILED') return 'Başarısız';
  if (st === 'PENDING') return 'Bekliyor';
  if (st === 'QUEUED' || st === 'SENDING') return 'Kuyrukta';
  if (st === 'CANCELLED') return 'İptal';
  if (st === 'SKIPPED') {
    return humanizeRecipientBlock(String(skipReason || '')) || 'Gönderilmedi';
  }
  return 'Bilinmiyor';
}

export function buildWhatsAppBulkSampleCsv(): Buffer {
  const csv =
    'Telefon,Ad Soyad,ad,firma\n' +
    '+905551112233,Ali Yılmaz,Ali,Örnek A.Ş.\n' +
    '05552223344,Ayşe Demir,Ayşe,\n';
  return Buffer.from('\uFEFF' + csv, 'utf8');
}

export async function exportWhatsAppCampaignResults(
  tenantId: number,
  campaignId: number
): Promise<Buffer> {
  const campaign = await getCampaignForTenant(tenantId, campaignId);
  if (!campaign || String(campaign.channel_type || '').toUpperCase() !== 'WHATSAPP') {
    throw Object.assign(new Error('Kampanya bulunamadı'), { status: 404 });
  }

  const rows = await query(
    `SELECT phone, display_name, status, skip_reason, last_error, sent_at
     FROM campaign_recipients
     WHERE campaign_id = $1 AND tenant_id = $2
     ORDER BY id`,
    [campaignId, tenantId]
  );

  const sheetRows = rows.rows.map((r: any) => ({
    Telefon: r.phone || '',
    'Ad Soyad': r.display_name || '',
    Durum: mapRecipientStatusLabel(r.status, r.skip_reason),
    Açıklama: r.last_error ? humanizeCampaignRecipientError(r.last_error) : '',
    'Gönderim zamanı': r.sent_at ? new Date(r.sent_at).toISOString() : '',
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(sheetRows);
  XLSX.utils.book_append_sheet(wb, ws, 'Sonuçlar');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export { pauseCampaign, cancelCampaign, resumeCampaign };

export function sanitizeRecipientRowError(error?: string | null): string | null {
  if (!error) return null;
  return sanitizeOutboundErrorMessage(humanizeCampaignRecipientError(error));
}
