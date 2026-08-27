import * as XLSX from 'xlsx';
import { getClient, query } from '../config/database';
import { normalizeEmail, normalizePhone, getTenantDefaultCountryCode } from '../utils/contactNormalize';
import { isValidEmailAddress, normalizeEmailAddress } from './suppressionService';
import {
  CONTACT_LIST_SAMPLE_COLUMNS,
  formatContactListMemberLabel,
} from './contactListImportMapping';

export { formatContactListMemberLabel };

export type ContactListRow = {
  id: number;
  tenant_id: number;
  name: string;
  description: string | null;
  is_active: boolean;
  member_count: number;
  valid_email_count?: number;
  valid_phone_count?: number;
  permission_ok_count?: number;
  created_at: string;
  updated_at: string;
};

async function assertList(tenantId: number, listId: number) {
  const res = await query(
    `SELECT * FROM contact_lists WHERE id = $1 AND tenant_id = $2`,
    [listId, tenantId]
  );
  return res.rows[0] || null;
}

async function refreshMemberCount(client: any, tenantId: number, listId: number) {
  await client.query(
    `UPDATE contact_lists
     SET member_count = (
       SELECT COUNT(*)::int FROM contact_list_members
       WHERE tenant_id = $1 AND list_id = $2
     ),
     updated_at = CURRENT_TIMESTAMP
     WHERE id = $2 AND tenant_id = $1`,
    [tenantId, listId]
  );
}

export async function listContactLists(tenantId: number, params?: { q?: string; active_only?: boolean }) {
  const values: unknown[] = [tenantId];
  let sql = `
    SELECT cl.*,
      (
        SELECT COUNT(DISTINCT clm.contact_id)::int
        FROM contact_list_members clm
        JOIN contacts c ON c.id = clm.contact_id AND c.tenant_id = clm.tenant_id
        JOIN contact_points cp ON cp.contact_id = c.id AND cp.tenant_id = c.tenant_id
          AND cp.channel_type = 'EMAIL' AND cp.is_active = true
          AND cp.normalized_value ~ '^[^@]+@[^@]+\\.[^@]+$'
        WHERE clm.tenant_id = cl.tenant_id AND clm.list_id = cl.id AND c.status = 'ACTIVE'
      ) AS valid_email_count,
      (
        SELECT COUNT(DISTINCT clm.contact_id)::int
        FROM contact_list_members clm
        JOIN contacts c ON c.id = clm.contact_id AND c.tenant_id = clm.tenant_id
        JOIN contact_points cp ON cp.contact_id = c.id AND cp.tenant_id = c.tenant_id
          AND cp.channel_type IN ('WHATSAPP', 'SMS') AND cp.is_active = true
          AND cp.normalized_value IS NOT NULL AND length(cp.normalized_value) >= 10
        WHERE clm.tenant_id = cl.tenant_id AND clm.list_id = cl.id AND c.status = 'ACTIVE'
      ) AS valid_phone_count,
      (
        SELECT COUNT(DISTINCT clm.contact_id)::int
        FROM contact_list_members clm
        JOIN contacts c ON c.id = clm.contact_id AND c.tenant_id = clm.tenant_id
        WHERE clm.tenant_id = cl.tenant_id AND clm.list_id = cl.id AND c.status = 'ACTIVE'
          AND EXISTS (
            SELECT 1 FROM communication_preferences pref
            WHERE pref.tenant_id = c.tenant_id AND pref.contact_id = c.id
              AND pref.channel_type IN ('EMAIL', 'WHATSAPP')
              AND pref.status = 'OPTED_IN'
          )
      ) AS permission_ok_count
    FROM contact_lists cl
    WHERE cl.tenant_id = $1
  `;
  if (params?.active_only) {
    sql += ` AND cl.is_active = true`;
  }
  if (params?.q?.trim()) {
    values.push(`%${params.q.trim()}%`);
    sql += ` AND cl.name ILIKE $${values.length}`;
  }
  sql += ` ORDER BY cl.updated_at DESC, cl.name ASC`;
  const result = await query(sql, values);
  return result.rows;
}

export async function getContactList(tenantId: number, listId: number) {
  const rows = await listContactLists(tenantId);
  return rows.find((r: any) => Number(r.id) === Number(listId)) || null;
}

export async function createContactList(params: {
  tenantId: number;
  userId: number;
  name: string;
  description?: string | null;
}) {
  const name = String(params.name || '').trim();
  if (!name) throw Object.assign(new Error('Liste adı gerekli'), { status: 400 });
  try {
    const result = await query(
      `INSERT INTO contact_lists (tenant_id, name, description, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [params.tenantId, name, params.description || null, params.userId]
    );
    return result.rows[0];
  } catch (err: any) {
    if (err.code === '23505') {
      throw Object.assign(new Error('Bu isimde bir liste zaten var'), { status: 409 });
    }
    throw err;
  }
}

export async function updateContactList(
  tenantId: number,
  listId: number,
  patch: { name?: string; description?: string | null; is_active?: boolean }
) {
  const existing = await assertList(tenantId, listId);
  if (!existing) return null;

  const fields: string[] = [];
  const values: unknown[] = [listId, tenantId];
  if (patch.name !== undefined) {
    values.push(String(patch.name).trim());
    fields.push(`name = $${values.length}`);
  }
  if (patch.description !== undefined) {
    values.push(patch.description);
    fields.push(`description = $${values.length}`);
  }
  if (patch.is_active !== undefined) {
    values.push(Boolean(patch.is_active));
    fields.push(`is_active = $${values.length}`);
  }
  if (fields.length === 0) return existing;
  fields.push('updated_at = CURRENT_TIMESTAMP');

  const result = await query(
    `UPDATE contact_lists SET ${fields.join(', ')}
     WHERE id = $1 AND tenant_id = $2
     RETURNING *`,
    values
  );
  return result.rows[0];
}

export async function deleteContactList(tenantId: number, listId: number) {
  const existing = await assertList(tenantId, listId);
  if (!existing) return false;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM contact_list_members WHERE tenant_id = $1 AND list_id = $2`,
      [tenantId, listId]
    );
    await client.query(`DELETE FROM contact_lists WHERE id = $1 AND tenant_id = $2`, [
      listId,
      tenantId,
    ]);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listContactListMembers(
  tenantId: number,
  listId: number,
  params?: { q?: string; limit?: number; offset?: number }
) {
  const list = await assertList(tenantId, listId);
  if (!list) return null;

  const values: unknown[] = [tenantId, listId];
  let whereSql = `
    FROM contact_list_members clm
    JOIN contacts c ON c.id = clm.contact_id AND c.tenant_id = clm.tenant_id
    WHERE clm.tenant_id = $1 AND clm.list_id = $2
  `;
  if (params?.q?.trim()) {
    values.push(`%${params.q.trim()}%`);
    whereSql += ` AND (
      c.first_name ILIKE $${values.length}
      OR c.last_name ILIKE $${values.length}
      OR c.company_name ILIKE $${values.length}
      OR EXISTS (
        SELECT 1 FROM contact_points cp
        WHERE cp.tenant_id = c.tenant_id AND cp.contact_id = c.id
          AND cp.is_active = true
          AND (
            (cp.channel_type = 'EMAIL' AND cp.normalized_value ILIKE $${values.length})
            OR (cp.channel_type IN ('WHATSAPP', 'SMS') AND cp.normalized_value ILIKE $${values.length})
          )
      )
    )`;
  }

  const countRes = await query(`SELECT COUNT(*)::int AS total ${whereSql}`, values);
  const total = Number(countRes.rows[0]?.total || 0);

  let sql = `
    SELECT c.id, c.first_name, c.last_name, c.company_name, c.status,
           clm.added_at,
           (
             SELECT cp.normalized_value FROM contact_points cp
             WHERE cp.tenant_id = c.tenant_id AND cp.contact_id = c.id
               AND cp.channel_type = 'EMAIL' AND cp.is_active = true
             ORDER BY cp.is_primary DESC, cp.id LIMIT 1
           ) AS email,
           (
             SELECT cp.normalized_value FROM contact_points cp
             WHERE cp.tenant_id = c.tenant_id AND cp.contact_id = c.id
               AND cp.channel_type IN ('WHATSAPP', 'SMS') AND cp.is_active = true
             ORDER BY CASE cp.channel_type WHEN 'WHATSAPP' THEN 0 ELSE 1 END,
                      cp.is_primary DESC, cp.id LIMIT 1
           ) AS phone,
           (
             SELECT pref.status FROM communication_preferences pref
             WHERE pref.tenant_id = c.tenant_id AND pref.contact_id = c.id
               AND pref.channel_type = 'EMAIL'
             ORDER BY pref.updated_at DESC NULLS LAST, pref.id DESC
             LIMIT 1
           ) AS email_permission,
           (
             SELECT pref.status FROM communication_preferences pref
             WHERE pref.tenant_id = c.tenant_id AND pref.contact_id = c.id
               AND pref.channel_type = 'WHATSAPP'
             ORDER BY pref.updated_at DESC NULLS LAST, pref.id DESC
             LIMIT 1
           ) AS whatsapp_permission
    ${whereSql}
  `;
  sql += ` ORDER BY clm.added_at DESC, c.id DESC`;
  if (params?.limit) {
    values.push(params.limit);
    sql += ` LIMIT $${values.length}`;
  }
  if (params?.offset) {
    values.push(params.offset);
    sql += ` OFFSET $${values.length}`;
  }
  const result = await query(sql, values);
  return {
    rows: result.rows.map((m: any) => ({
      ...m,
      display_name: formatContactListMemberLabel(m),
    })),
    total,
  };
}

export async function addContactListMembers(params: {
  tenantId: number;
  listId: number;
  userId: number;
  contactIds: number[];
}) {
  const list = await assertList(params.tenantId, params.listId);
  if (!list) return null;
  const ids = [...new Set(params.contactIds.map(Number).filter((n) => n > 0))];
  if (ids.length === 0) return { added: 0 };

  const client = await getClient();
  try {
    await client.query('BEGIN');
    let added = 0;
    for (const contactId of ids) {
      const ok = await client.query(
        `SELECT id FROM contacts WHERE id = $1 AND tenant_id = $2 AND status = 'ACTIVE'`,
        [contactId, params.tenantId]
      );
      if (ok.rows.length === 0) continue;
      const ins = await client.query(
        `INSERT INTO contact_list_members (tenant_id, list_id, contact_id, added_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, list_id, contact_id) DO NOTHING
         RETURNING id`,
        [params.tenantId, params.listId, contactId, params.userId]
      );
      if (ins.rows.length > 0) added += 1;
    }
    await refreshMemberCount(client, params.tenantId, params.listId);
    await client.query('COMMIT');
    return { added };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function removeContactListMember(tenantId: number, listId: number, contactId: number) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM contact_list_members
       WHERE tenant_id = $1 AND list_id = $2 AND contact_id = $3`,
      [tenantId, listId, contactId]
    );
    await refreshMemberCount(client, tenantId, listId);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function permissionExportLabel(status?: string | null): string {
  if (status === 'OPTED_IN') return 'İzinli';
  if (status === 'OPTED_OUT') return 'Red';
  if (status === 'BLOCKED') return 'Engelli';
  return 'Bilinmiyor';
}

async function loadExportMemberRows(tenantId: number, listId: number) {
  const list = await assertList(tenantId, listId);
  if (!list) throw Object.assign(new Error('Liste bulunamadı'), { status: 404 });

  const batch = await listContactListMembers(tenantId, listId, { limit: 10000, offset: 0 });
  return (batch?.rows || []).map((m: any) => ({
    'Kurum / Kişi Adı': String(m.company_name || '').trim() || formatContactListMemberLabel(m),
    'Yetkili Adı': [m.first_name, m.last_name].filter(Boolean).join(' ').trim(),
    'E-posta': m.email || '',
    Telefon: m.phone || '',
    Şehir: '',
    Not: '',
    'E-posta İzni': permissionExportLabel(m.email_permission),
    'WhatsApp İzni': permissionExportLabel(m.whatsapp_permission),
    'Liste Üyeliği': list.name,
  }));
}

function buildContactListExportCsv(rows: Record<string, string>[]): Buffer {
  const headers = [
    'Kurum / Kişi Adı',
    'Yetkili Adı',
    'E-posta',
    'Telefon',
    'Şehir',
    'Not',
    'E-posta İzni',
    'WhatsApp İzni',
    'Liste Üyeliği',
  ];
  const escape = (value: string) => {
    const v = String(value ?? '');
    if (/[",;\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
    return v;
  };
  const lines = [
    headers.join(';'),
    ...rows.map((row) => headers.map((h) => escape(String(row[h] ?? ''))).join(';')),
  ];
  return Buffer.from('\uFEFF' + lines.join('\r\n'), 'utf8');
}

const SAMPLE_ROW = {
  'Kurum / Kişi Adı': 'Örnek Baro',
  'Yetkili Adı': 'Ali Yılmaz',
  'E-posta': 'ali@ornekbaro.org.tr',
  Telefon: '+905551112233',
  Şehir: 'İstanbul',
  Not: 'Örnek not',
  'E-posta İzni': 'evet',
  'WhatsApp İzni': 'hayır',
};

export async function exportContactList(
  tenantId: number,
  listId: number,
  format: 'xlsx' | 'csv' = 'xlsx'
): Promise<Buffer> {
  const list = await assertList(tenantId, listId);
  if (!list) throw Object.assign(new Error('Liste bulunamadı'), { status: 404 });

  const rows = await loadExportMemberRows(tenantId, listId);
  if (format === 'csv') {
    return buildContactListExportCsv(rows);
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    { wch: 28 },
    { wch: 22 },
    { wch: 28 },
    { wch: 16 },
    { wch: 14 },
    { wch: 18 },
    { wch: 14 },
    { wch: 16 },
    { wch: 18 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, list.name.slice(0, 31));
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export function buildContactListSampleCsv(): Buffer {
  const headers = [...CONTACT_LIST_SAMPLE_COLUMNS];
  const escape = (value: string) => {
    const v = String(value ?? '');
    if (/[",;\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
    return v;
  };
  const line = (row: Record<string, string>) =>
    headers.map((h) => escape(String(row[h] ?? ''))).join(';');
  return Buffer.from(
    '\uFEFF' + headers.join(';') + '\r\n' + line(SAMPLE_ROW as Record<string, string>) + '\r\n',
    'utf8'
  );
}

export function buildContactListSampleXlsx(): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet([SAMPLE_ROW]);
  ws['!cols'] = [
    { wch: 24 },
    { wch: 18 },
    { wch: 28 },
    { wch: 16 },
    { wch: 14 },
    { wch: 18 },
    { wch: 14 },
    { wch: 16 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Ornek');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export async function resolveListContactIds(tenantId: number, listIds: number[]): Promise<number[]> {
  const ids = [...new Set(listIds.map(Number).filter((n) => n > 0))];
  if (ids.length === 0) return [];
  const res = await query(
    `SELECT DISTINCT clm.contact_id
     FROM contact_list_members clm
     JOIN contact_lists cl ON cl.id = clm.list_id AND cl.tenant_id = clm.tenant_id
     JOIN contacts c ON c.id = clm.contact_id AND c.tenant_id = clm.tenant_id
     WHERE clm.tenant_id = $1
       AND clm.list_id = ANY($2::int[])
       AND cl.is_active = true
       AND c.status = 'ACTIVE'`,
    [tenantId, ids]
  );
  return res.rows.map((r: any) => Number(r.contact_id));
}

export async function getContactListNames(tenantId: number, listIds: number[]): Promise<string[]> {
  if (!listIds.length) return [];
  const res = await query(
    `SELECT name FROM contact_lists
     WHERE tenant_id = $1 AND id = ANY($2::int[])`,
    [tenantId, listIds]
  );
  return res.rows.map((r: any) => String(r.name));
}

export async function loadContactsFromLists(tenantId: number, listIds: number[]) {
  const contactIds = await resolveListContactIds(tenantId, listIds);
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
            ) AS email_normalized,
            (
              SELECT cp2.normalized_value
              FROM contact_points cp2
              WHERE cp2.tenant_id = c.tenant_id AND cp2.contact_id = c.id
                AND cp2.channel_type IN ('WHATSAPP', 'SMS') AND cp2.is_active = true
              ORDER BY CASE cp2.channel_type WHEN 'WHATSAPP' THEN 0 ELSE 1 END,
                       cp2.is_primary DESC, cp2.id
              LIMIT 1
            ) AS wa_phone
     FROM contacts c
     LEFT JOIN LATERAL (
       SELECT value, normalized_value, channel_type
       FROM contact_points
       WHERE tenant_id = c.tenant_id AND contact_id = c.id AND is_active = true
         AND channel_type IN ('WHATSAPP', 'SMS')
       ORDER BY CASE channel_type WHEN 'WHATSAPP' THEN 0 ELSE 1 END,
                is_primary DESC, id
       LIMIT 1
     ) cp ON true
     WHERE c.tenant_id = $1 AND c.id = ANY($2::int[]) AND c.status = 'ACTIVE'`,
    [tenantId, contactIds]
  );

  return res.rows.map((row: any) => {
    const phone = row.wa_phone || row.phone_normalized || row.phone_value || '';
    const ad = String(row.first_name || '').trim();
    const soyad = String(row.last_name || '').trim();
    return {
      contact_id: Number(row.id),
      phone,
      display_name:
        [ad, soyad].filter(Boolean).join(' ').trim() || row.company_name || 'İsimsiz kişi',
      fields: {
        ad,
        soyad,
        tam_ad: [ad, soyad].filter(Boolean).join(' ').trim(),
        firma: String(row.company_name || '').trim(),
        telefon: phone,
        email: String(row.email_normalized || '').trim(),
      },
    };
  });
}

export function parsePermissionCell(raw: string): 'OPTED_IN' | 'OPTED_OUT' | 'UNKNOWN' {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return 'UNKNOWN';
  if (['evet', 'yes', '1', 'true', 'izinli', 'opted_in', 'on'].includes(v)) return 'OPTED_IN';
  if (['hayır', 'hayir', 'no', '0', 'false', 'red', 'opted_out', 'off'].includes(v))
    return 'OPTED_OUT';
  return 'UNKNOWN';
}

function parseAudienceConfig(raw: unknown): { mode?: string; list_ids?: number[] } {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw as { mode?: string; list_ids?: number[] };
}

export async function getCampaignListStats(
  tenantId: number,
  campaignId: number,
  listIds: number[]
): Promise<Array<{ id: number; name: string; total: number; sent: number; failed: number }>> {
  if (!listIds.length) return [];
  const res = await query(
    `SELECT cl.id, cl.name,
       COUNT(DISTINCT clm.contact_id)::int AS total,
       COUNT(DISTINCT CASE WHEN cr.status IN ('SENT', 'DELIVERED') THEN clm.contact_id END)::int AS sent,
       COUNT(DISTINCT CASE WHEN cr.status IN ('FAILED', 'BOUNCED')
         OR (cr.status = 'SKIPPED' AND cr.skip_reason IS NOT NULL) THEN clm.contact_id END)::int AS failed
     FROM contact_lists cl
     JOIN contact_list_members clm ON clm.list_id = cl.id AND clm.tenant_id = cl.tenant_id
     LEFT JOIN campaign_recipients cr ON cr.campaign_id = $3 AND cr.tenant_id = clm.tenant_id
       AND cr.contact_id = clm.contact_id
     WHERE cl.tenant_id = $1 AND cl.id = ANY($2::int[])
     GROUP BY cl.id, cl.name
     ORDER BY cl.name ASC`,
    [tenantId, listIds, campaignId]
  );
  return res.rows.map((r: any) => ({
    id: Number(r.id),
    name: String(r.name),
    total: Number(r.total),
    sent: Number(r.sent),
    failed: Number(r.failed),
  }));
}

export async function enrichCampaignsWithListMeta(tenantId: number, campaigns: any[]) {
  for (const c of campaigns) {
    const aud = parseAudienceConfig(c.audience_config);
    const listIds = (aud.list_ids || []).map(Number).filter((n: number) => n > 0);
    if (!listIds.length) continue;
    c.list_names = await getContactListNames(tenantId, listIds);
    c.list_stats = await getCampaignListStats(tenantId, Number(c.id), listIds);
  }
  return campaigns;
}
