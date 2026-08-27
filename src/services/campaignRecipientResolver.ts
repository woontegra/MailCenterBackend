import { query } from '../config/database';
import { getImportRowsForCampaign } from './campaignImportService';
import { loadSegmentFilters, resolveSegmentContactIds } from './campaignSegmentService';
import {
  findSuppressedEmails,
  isValidEmailAddress,
  normalizeEmailAddress,
} from './suppressionService';

export type AudienceMode = 'ALL' | 'TAG' | 'COMPANY' | 'MANUAL' | 'SEGMENT' | 'IMPORT' | 'LIST';

export type AudienceConfig = {
  mode?: AudienceMode;
  tag_ids?: number[];
  company_name?: string;
  contact_ids?: number[];
  segment_id?: number;
  import_id?: number;
  list_ids?: number[];
};

export type ResolvedRecipient = {
  contact_id: number | null;
  email: string;
  email_normalized: string;
  display_name: string;
  personalisation_data: Record<string, string>;
  source?: string;
  source_ref_id?: number | null;
};

export type RecipientPreparationSummary = {
  initial_total: number;
  list_total?: number;
  duplicate_removed: number;
  invalid_removed: number;
  missing_email_removed: number;
  no_email_permission?: number;
  unsubscribed_removed: number;
  blocked_removed: number;
  bounce_removed?: number;
  suppressed_removed: number;
  final_total: number;
  sendable?: number;
};

function buildPersonalisation(row: {
  first_name?: string | null;
  last_name?: string | null;
  company_name?: string | null;
  email?: string;
  phone?: string | null;
  brand_name?: string | null;
}): Record<string, string> {
  const ad = String(row.first_name || '').trim();
  const soyad = String(row.last_name || '').trim();
  const tamAd = [ad, soyad].filter(Boolean).join(' ').trim() || 'Müşteri';
  return {
    ad: ad || 'Müşteri',
    soyad,
    tam_ad: tamAd,
    firma: String(row.company_name || '').trim() || 'Firma',
    email: String(row.email || '').trim(),
    telefon: String(row.phone || '').trim() || '+90 555 000 00 00',
    marka_adi: String(row.brand_name || '').trim() || 'Marka',
    abonelikten_cikma_linki: '{{abonelikten_cikma_linki}}',
  };
}

function dedupeRecipients(rows: ResolvedRecipient[]): {
  recipients: ResolvedRecipient[];
  duplicateRemoved: number;
  invalidRemoved: number;
  missingEmailRemoved: number;
} {
  const seen = new Set<string>();
  const out: ResolvedRecipient[] = [];
  let duplicateRemoved = 0;
  let invalidRemoved = 0;
  let missingEmailRemoved = 0;
  for (const row of rows) {
    const key = row.email_normalized;
    if (!key) {
      missingEmailRemoved += 1;
      continue;
    }
    if (!isValidEmailAddress(key)) {
      invalidRemoved += 1;
      continue;
    }
    if (seen.has(key)) {
      duplicateRemoved += 1;
      continue;
    }
    seen.add(key);
    out.push(row);
  }
  return { recipients: out, duplicateRemoved, invalidRemoved, missingEmailRemoved };
}

async function loadBrandName(tenantId: number, brandId: number | null): Promise<string> {
  if (!brandId) return 'Marka';
  const res = await query(`SELECT name FROM brands WHERE id = $1 AND tenant_id = $2`, [
    brandId,
    tenantId,
  ]);
  return res.rows[0]?.name || 'Marka';
}

async function loadContactRecipients(params: {
  tenantId: number;
  brandId: number | null;
  audience: AudienceConfig;
}): Promise<ResolvedRecipient[]> {
  const { tenantId, brandId, audience } = params;
  const mode = audience.mode || 'ALL';
  const brandName = await loadBrandName(tenantId, brandId);

  const baseFrom = `
    FROM contacts c
    JOIN contact_points cp ON cp.contact_id = c.id AND cp.tenant_id = c.tenant_id
    LEFT JOIN LATERAL (
      SELECT value FROM contact_points
      WHERE contact_id = c.id AND tenant_id = c.tenant_id
        AND channel_type = 'SMS' AND is_active = true
      ORDER BY is_primary DESC, id LIMIT 1
    ) phone ON true
    WHERE c.tenant_id = $1
      AND c.status = 'ACTIVE'
      AND cp.channel_type = 'EMAIL'
      AND cp.is_active = true
      AND cp.value IS NOT NULL
      AND TRIM(cp.value) <> ''
  `;

  const consentFilter = brandId
    ? `AND NOT EXISTS (
      SELECT 1 FROM communication_preferences pref
      WHERE pref.tenant_id = c.tenant_id
        AND pref.contact_id = c.id
        AND pref.channel_type = 'EMAIL'
        AND (pref.brand_id IS NULL OR pref.brand_id = $2)
        AND pref.status IN ('OPTED_OUT', 'BLOCKED')
    )`
    : `AND NOT EXISTS (
      SELECT 1 FROM communication_preferences pref
      WHERE pref.tenant_id = c.tenant_id
        AND pref.contact_id = c.id
        AND pref.channel_type = 'EMAIL'
        AND pref.brand_id IS NULL
        AND pref.status IN ('OPTED_OUT', 'BLOCKED')
    )`;

  const brandScope = brandId
    ? `AND EXISTS (
        SELECT 1 FROM contact_brand_links cbl
        WHERE cbl.tenant_id = c.tenant_id AND cbl.contact_id = c.id AND cbl.brand_id = $2
      )`
    : '';

  let rows: any[] = [];

  if (mode === 'SEGMENT') {
    const segmentId = Number(audience.segment_id);
    if (!segmentId) return [];
    const filters = await loadSegmentFilters(tenantId, segmentId);
    if (!filters) return [];
    const contactIds = await resolveSegmentContactIds(tenantId, filters);
    if (contactIds.length === 0) return [];
    const res = await query(
      `SELECT DISTINCT ON (LOWER(TRIM(cp.value)))
         c.id AS contact_id, c.first_name, c.last_name, c.company_name,
         cp.value AS email, phone.value AS phone
       ${baseFrom}
       AND c.id = ANY($3::int[])
       ${consentFilter}
       ORDER BY LOWER(TRIM(cp.value)), cp.is_primary DESC, cp.id`,
      [tenantId, brandId, contactIds]
    );
    rows = res.rows;
  } else if (mode === 'MANUAL') {
    const ids = (audience.contact_ids || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
    if (ids.length === 0) return [];
    const res = await query(
      `SELECT DISTINCT ON (LOWER(TRIM(cp.value)))
         c.id AS contact_id, c.first_name, c.last_name, c.company_name,
         cp.value AS email, phone.value AS phone
       ${baseFrom}
       AND c.id = ANY($3::int[])
       ${consentFilter}
       ORDER BY LOWER(TRIM(cp.value)), cp.is_primary DESC, cp.id`,
      [tenantId, brandId, ids]
    );
    rows = res.rows;
  } else if (mode === 'COMPANY') {
    const company = String(audience.company_name || '').trim();
    if (!company) return [];
    const res = await query(
      `SELECT DISTINCT ON (LOWER(TRIM(cp.value)))
         c.id AS contact_id, c.first_name, c.last_name, c.company_name,
         cp.value AS email, phone.value AS phone
       ${baseFrom}
       AND c.company_name ILIKE $3
       ${brandScope}
       ${consentFilter}
       ORDER BY LOWER(TRIM(cp.value)), cp.is_primary DESC, cp.id`,
      [tenantId, brandId, company]
    );
    rows = res.rows;
  } else if (mode === 'LIST') {
    const listIds = (audience.list_ids || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
    if (listIds.length === 0) return [];
    const listConsent = brandId
      ? `AND EXISTS (
          SELECT 1 FROM communication_preferences pref
          WHERE pref.tenant_id = c.tenant_id AND pref.contact_id = c.id
            AND pref.channel_type = 'EMAIL'
            AND (pref.brand_id IS NULL OR pref.brand_id = $2)
            AND pref.status = 'OPTED_IN'
        )`
      : `AND EXISTS (
          SELECT 1 FROM communication_preferences pref
          WHERE pref.tenant_id = c.tenant_id AND pref.contact_id = c.id
            AND pref.channel_type = 'EMAIL'
            AND pref.brand_id IS NULL
            AND pref.status = 'OPTED_IN'
        )`;
    const res = await query(
      `SELECT DISTINCT ON (LOWER(TRIM(cp.value)))
         c.id AS contact_id, c.first_name, c.last_name, c.company_name,
         cp.value AS email, phone.value AS phone
       ${baseFrom}
       AND EXISTS (
         SELECT 1 FROM contact_list_members clm
         JOIN contact_lists cl ON cl.id = clm.list_id AND cl.tenant_id = clm.tenant_id
         WHERE clm.tenant_id = c.tenant_id AND clm.contact_id = c.id
           AND clm.list_id = ANY($${brandId ? 3 : 2}::int[]) AND cl.is_active = true
       )
       ${brandScope}
       ${listConsent}
       ORDER BY LOWER(TRIM(cp.value)), cp.is_primary DESC, cp.id`,
      brandId ? [tenantId, brandId, listIds] : [tenantId, listIds]
    );
    rows = res.rows;
  } else if (mode === 'TAG') {
    const tagIds = (audience.tag_ids || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
    if (tagIds.length === 0) return [];
    const res = await query(
      `SELECT DISTINCT ON (LOWER(TRIM(cp.value)))
         c.id AS contact_id, c.first_name, c.last_name, c.company_name,
         cp.value AS email, phone.value AS phone
       ${baseFrom}
       AND EXISTS (
         SELECT 1 FROM contact_tag_links ctl
         WHERE ctl.tenant_id = c.tenant_id AND ctl.contact_id = c.id AND ctl.tag_id = ANY($3::int[])
       )
       ${brandScope}
       ${consentFilter}
       ORDER BY LOWER(TRIM(cp.value)), cp.is_primary DESC, cp.id`,
      [tenantId, brandId, tagIds]
    );
    rows = res.rows;
  } else {
    const res = await query(
      `SELECT DISTINCT ON (LOWER(TRIM(cp.value)))
         c.id AS contact_id, c.first_name, c.last_name, c.company_name,
         cp.value AS email, phone.value AS phone
       ${baseFrom}
       ${brandScope}
       ${consentFilter}
       ORDER BY LOWER(TRIM(cp.value)), cp.is_primary DESC, cp.id`,
      brandId ? [tenantId, brandId] : [tenantId]
    );
    rows = res.rows;
  }

  const mapped = rows.map((r) => {
    const email = String(r.email || '').trim();
    return {
      contact_id: r.contact_id ? Number(r.contact_id) : null,
      email,
      email_normalized: normalizeEmailAddress(email),
      display_name:
        [r.first_name, r.last_name].filter(Boolean).join(' ').trim() ||
        r.company_name ||
        email,
      personalisation_data: buildPersonalisation({ ...r, email, brand_name: brandName }),
      source: 'audience',
      source_ref_id: r.contact_id ? Number(r.contact_id) : null,
    };
  });

  return mapped;
}

async function loadImportRecipients(params: {
  tenantId: number;
  brandId: number | null;
  audience: AudienceConfig;
}): Promise<ResolvedRecipient[]> {
  const importId = Number(params.audience.import_id);
  if (!importId) return [];
  const brandName = await loadBrandName(params.tenantId, params.brandId);
  const rows = await getImportRowsForCampaign(params.tenantId, importId);
  return rows.map((row) => {
    const email = String(row.email || '').trim();
    return {
      contact_id: row.contact_id ? Number(row.contact_id) : null,
      email,
      email_normalized: normalizeEmailAddress(email),
      display_name:
        [row.first_name, row.last_name].filter(Boolean).join(' ').trim() ||
        row.company_name ||
        email,
      personalisation_data: buildPersonalisation({
        first_name: row.first_name,
        last_name: row.last_name,
        company_name: row.company_name,
        email,
        phone: row.phone,
        brand_name: brandName,
      }),
      source: 'import',
      source_ref_id: row.id ? Number(row.id) : importId,
    };
  });
}

export async function prepareCampaignRecipients(params: {
  tenantId: number;
  brandId: number | null;
  audience: AudienceConfig;
}): Promise<{ recipients: ResolvedRecipient[]; summary: RecipientPreparationSummary }> {
  const raw =
    params.audience.mode === 'IMPORT'
      ? await loadImportRecipients(params)
      : await loadContactRecipients(params);

  const deduped = dedupeRecipients(raw);
  const suppressions = await findSuppressedEmails(
    params.tenantId,
    deduped.recipients.map((r) => r.email_normalized)
  );

  let unsubscribed = 0;
  let blocked = 0;
  let suppressed = 0;
  const finalRecipients: ResolvedRecipient[] = [];

  for (const recipient of deduped.recipients) {
    const sup = suppressions.get(recipient.email_normalized);
    if (!sup) {
      finalRecipients.push(recipient);
      continue;
    }
    suppressed += 1;
    if (sup.reason === 'UNSUBSCRIBED') unsubscribed += 1;
    else blocked += 1;
  }

  return {
    recipients: finalRecipients,
    summary: {
      initial_total: raw.length,
      duplicate_removed: deduped.duplicateRemoved,
      invalid_removed: deduped.invalidRemoved,
      missing_email_removed: deduped.missingEmailRemoved,
      unsubscribed_removed: unsubscribed,
      blocked_removed: blocked,
      suppressed_removed: suppressed,
      final_total: finalRecipients.length,
    },
  };
}

export async function resolveCampaignRecipients(params: {
  tenantId: number;
  brandId: number | null;
  audience: AudienceConfig;
}): Promise<ResolvedRecipient[]> {
  return (await prepareCampaignRecipients(params)).recipients;
}

export async function previewAudienceCount(params: {
  tenantId: number;
  brandId: number | null;
  audience: AudienceConfig;
}): Promise<{ count: number; summary: RecipientPreparationSummary }> {
  const prepared = await prepareCampaignRecipients(params);
  return { count: prepared.recipients.length, summary: prepared.summary };
}

export async function previewListEmailAudience(params: {
  tenantId: number;
  brandId: number | null;
  listIds: number[];
}) {
  const { resolveListContactIds } = await import('./contactListService');
  const contactIds = await resolveListContactIds(params.tenantId, params.listIds);
  const listTotal = contactIds.length;

  if (contactIds.length === 0) {
    return {
      count: 0,
      summary: {
        list_total: 0,
        initial_total: 0,
        sendable: 0,
        duplicate_removed: 0,
        invalid_removed: 0,
        missing_email_removed: 0,
        no_email_permission: 0,
        unsubscribed_removed: 0,
        blocked_removed: 0,
        bounce_removed: 0,
        suppressed_removed: 0,
        final_total: 0,
      },
    };
  }

  const audience: AudienceConfig = { mode: 'LIST', list_ids: params.listIds };
  const prepared = await prepareCampaignRecipients({
    tenantId: params.tenantId,
    brandId: params.brandId,
    audience,
  });

  const rawEmails = await query(
    `SELECT DISTINCT c.id AS contact_id, cp.normalized_value AS email_normalized
     FROM contacts c
     JOIN contact_list_members clm ON clm.contact_id = c.id AND clm.tenant_id = c.tenant_id
     JOIN contact_lists cl ON cl.id = clm.list_id AND cl.tenant_id = clm.tenant_id
     LEFT JOIN contact_points cp ON cp.contact_id = c.id AND cp.tenant_id = c.tenant_id
       AND cp.channel_type = 'EMAIL' AND cp.is_active = true
     WHERE c.tenant_id = $1 AND c.id = ANY($2::int[])
       AND clm.list_id = ANY($3::int[]) AND cl.is_active = true AND c.status = 'ACTIVE'`,
    [params.tenantId, contactIds, params.listIds]
  );

  let missingEmail = 0;
  let invalidEmail = 0;
  let noPermission = 0;
  const emailsToCheck: string[] = [];

  for (const row of rawEmails.rows) {
    const email = String(row.email_normalized || '').trim();
    if (!email) {
      missingEmail += 1;
      continue;
    }
    if (!isValidEmailAddress(email)) {
      invalidEmail += 1;
      continue;
    }
    emailsToCheck.push(normalizeEmailAddress(email));
  }

  const prefRows = await query(
    `SELECT contact_id, status FROM communication_preferences
     WHERE tenant_id = $1 AND contact_id = ANY($2::int[])
       AND channel_type = 'EMAIL'
       AND brand_id IS NULL`,
    [params.tenantId, contactIds]
  );
  const prefByContact = new Map<number, string>();
  for (const p of prefRows.rows) prefByContact.set(Number(p.contact_id), p.status);

  for (const cid of contactIds) {
    const st = prefByContact.get(cid) || 'UNKNOWN';
    if (st !== 'OPTED_IN') noPermission += 1;
  }

  const suppressions = await findSuppressedEmails(params.tenantId, emailsToCheck);
  let unsubscribed = 0;
  let bounce = 0;
  let blocked = 0;
  for (const [, sup] of suppressions) {
    if (sup.reason === 'UNSUBSCRIBED') unsubscribed += 1;
    else if (sup.reason === 'BOUNCE_PERMANENT') bounce += 1;
    else blocked += 1;
  }

  const summary: RecipientPreparationSummary = {
    list_total: listTotal,
    initial_total: prepared.summary.initial_total,
    sendable: prepared.recipients.length,
    duplicate_removed: prepared.summary.duplicate_removed,
    invalid_removed: invalidEmail,
    missing_email_removed: missingEmail,
    no_email_permission: noPermission,
    unsubscribed_removed: unsubscribed,
    blocked_removed: blocked,
    bounce_removed: bounce,
    suppressed_removed: prepared.summary.suppressed_removed,
    final_total: prepared.recipients.length,
  };

  return { count: prepared.recipients.length, summary };
}
