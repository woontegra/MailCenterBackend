import * as XLSX from 'xlsx';
import { getClient, query } from '../config/database';
import {
  findSuppressedEmails,
  isValidEmailAddress,
  normalizeEmailAddress,
  upsertSuppression,
} from './suppressionService';

export type ImportMapping = {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  company_name?: string;
  tags?: string;
};

export type ImportOptions = {
  update_existing?: boolean;
  save_new_contacts?: boolean;
  snapshot_only?: boolean;
};

type ParsedRow = Record<string, string>;

function parseCsv(buffer: Buffer): ParsedRow[] {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let current = '';
  let row: string[] = [];
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      row.push(current.trim());
      current = '';
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && next === '\n') i += 1;
      row.push(current.trim());
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
      current = '';
    } else {
      current += ch;
    }
  }
  row.push(current.trim());
  if (row.some((v) => v !== '')) rows.push(row);

  const [headers, ...data] = rows;
  if (!headers) return [];
  return data.map((values) => {
    const out: ParsedRow = {};
    headers.forEach((h, i) => {
      out[h || `Kolon ${i + 1}`] = values[i] || '';
    });
    return out;
  });
}

function parseWorkbook(buffer: Buffer): ParsedRow[] {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  return XLSX.utils.sheet_to_json<ParsedRow>(wb.Sheets[sheetName], { defval: '' });
}

export function parseRecipientFile(file: { originalname: string; buffer: Buffer }) {
  const lower = file.originalname.toLowerCase();
  const rows = lower.endsWith('.xlsx') || lower.endsWith('.xls')
    ? parseWorkbook(file.buffer)
    : parseCsv(file.buffer);
  const headers = rows[0] ? Object.keys(rows[0]) : [];
  return { headers, rows: rows.slice(0, 5000) };
}

function value(row: ParsedRow, key?: string) {
  if (!key) return '';
  return String(row[key] ?? '').trim();
}

function tagsValue(row: ParsedRow, key?: string) {
  return value(row, key)
    .split(/[;,]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

export async function previewRecipientImport(params: {
  tenantId: number;
  campaignId?: number | null;
  userId: number;
  filename: string;
  rows: ParsedRow[];
  mapping: ImportMapping;
}) {
  if (!params.mapping.email) {
    throw Object.assign(new Error('E-posta kolon eşlemesi zorunludur'), { status: 400 });
  }

  const mapped = params.rows.map((row, idx) => {
    const email = value(row, params.mapping.email);
    return {
      row_number: idx + 2,
      raw_data: row,
      first_name: value(row, params.mapping.first_name),
      last_name: value(row, params.mapping.last_name),
      email,
      email_normalized: normalizeEmailAddress(email),
      phone: value(row, params.mapping.phone),
      company_name: value(row, params.mapping.company_name),
      tags: tagsValue(row, params.mapping.tags),
    };
  });

  const seen = new Set<string>();
  const duplicateEmails = new Set<string>();
  for (const row of mapped) {
    if (!row.email_normalized) continue;
    if (seen.has(row.email_normalized)) duplicateEmails.add(row.email_normalized);
    seen.add(row.email_normalized);
  }

  const suppressions = await findSuppressedEmails(
    params.tenantId,
    mapped.map((r) => r.email_normalized)
  );

  const existing = await query(
    `SELECT c.id, cp.normalized_value
     FROM contacts c
     JOIN contact_points cp ON cp.contact_id = c.id AND cp.tenant_id = c.tenant_id
     WHERE c.tenant_id = $1 AND cp.channel_type = 'EMAIL'
       AND cp.normalized_value = ANY($2::text[])`,
    [params.tenantId, Array.from(seen)]
  );
  const existingByEmail = new Map<string, number>();
  for (const row of existing.rows) existingByEmail.set(row.normalized_value, Number(row.id));

  const summary = {
    total_rows: mapped.length,
    valid_rows: 0,
    missing_email: 0,
    invalid_email: 0,
    duplicate_rows: 0,
    existing_contacts: 0,
    suppressed: 0,
  };

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const importRes = await client.query(
      `INSERT INTO campaign_recipient_imports (
         tenant_id, campaign_id, filename, status, mapping, summary, created_by
       ) VALUES ($1,$2,$3,'PREVIEW',$4::jsonb,$5::jsonb,$6)
       RETURNING *`,
      [
        params.tenantId,
        params.campaignId || null,
        params.filename,
        JSON.stringify(params.mapping),
        JSON.stringify(summary),
        params.userId,
      ]
    );
    const importId = Number(importRes.rows[0].id);

    for (const row of mapped) {
      let status = 'VALID';
      let suppressionReason: string | null = null;
      const contactId = existingByEmail.get(row.email_normalized) || null;

      if (!row.email_normalized) {
        status = 'MISSING_EMAIL';
        summary.missing_email += 1;
      } else if (!isValidEmailAddress(row.email_normalized)) {
        status = 'INVALID_EMAIL';
        summary.invalid_email += 1;
        await upsertSuppression({
          tenantId: params.tenantId,
          email: row.email,
          reason: 'INVALID_ADDRESS',
          source: 'import_validation',
          campaignId: params.campaignId || null,
          createdBy: params.userId,
        }).catch(() => null);
      } else if (duplicateEmails.has(row.email_normalized)) {
        status = 'DUPLICATE_IN_FILE';
        summary.duplicate_rows += 1;
      } else if (suppressions.has(row.email_normalized)) {
        status = 'SUPPRESSED';
        suppressionReason = suppressions.get(row.email_normalized)?.reason || null;
        summary.suppressed += 1;
      } else if (contactId) {
        status = 'EXISTING_CONTACT';
        summary.existing_contacts += 1;
        summary.valid_rows += 1;
      } else {
        summary.valid_rows += 1;
      }

      await client.query(
        `INSERT INTO campaign_recipient_import_rows (
           import_id, tenant_id, campaign_id, row_number, raw_data,
           first_name, last_name, email, email_normalized, phone, company_name,
           tags, status, contact_id, suppression_reason
         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          importId,
          params.tenantId,
          params.campaignId || null,
          row.row_number,
          JSON.stringify(row.raw_data),
          row.first_name || null,
          row.last_name || null,
          row.email || null,
          row.email_normalized || null,
          row.phone || null,
          row.company_name || null,
          row.tags,
          status,
          contactId,
          suppressionReason,
        ]
      );
    }

    await client.query(
      `UPDATE campaign_recipient_imports
       SET summary = $3::jsonb, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND tenant_id = $2`,
      [importId, params.tenantId, JSON.stringify(summary)]
    );

    await client.query('COMMIT');
    return { import_id: importId, summary };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function ensureContactForRow(params: {
  tenantId: number;
  userId: number;
  row: any;
  updateExisting: boolean;
  saveNew: boolean;
}) {
  if (params.row.contact_id) {
    if (params.updateExisting) {
      await query(
        `UPDATE contacts
         SET first_name = COALESCE($3, first_name),
             last_name = COALESCE($4, last_name),
             company_name = COALESCE($5, company_name),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND tenant_id = $2`,
        [
          params.row.contact_id,
          params.tenantId,
          params.row.first_name || null,
          params.row.last_name || null,
          params.row.company_name || null,
        ]
      );
    }
    return Number(params.row.contact_id);
  }

  if (!params.saveNew) return null;

  const contact = await query(
    `INSERT INTO contacts (tenant_id, first_name, last_name, company_name, created_by)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id`,
    [
      params.tenantId,
      params.row.first_name || null,
      params.row.last_name || null,
      params.row.company_name || null,
      params.userId,
    ]
  );
  const contactId = Number(contact.rows[0].id);
  await query(
    `INSERT INTO contact_points (
       tenant_id, contact_id, channel_type, value, normalized_value, is_primary, is_active
     ) VALUES ($1,$2,'EMAIL',$3,$4,true,true)
     ON CONFLICT DO NOTHING`,
    [params.tenantId, contactId, params.row.email, params.row.email_normalized]
  );
  return contactId;
}

export async function applyRecipientImport(params: {
  tenantId: number;
  userId: number;
  importId: number;
  options: ImportOptions;
}) {
  const importRes = await query(
    `SELECT * FROM campaign_recipient_imports WHERE id = $1 AND tenant_id = $2`,
    [params.importId, params.tenantId]
  );
  const imp = importRes.rows[0];
  if (!imp) return null;

  const rows = await query(
    `SELECT * FROM campaign_recipient_import_rows
     WHERE import_id = $1 AND tenant_id = $2 AND status IN ('VALID', 'EXISTING_CONTACT')
     ORDER BY row_number`,
    [params.importId, params.tenantId]
  );

  let savedContacts = 0;
  if (!params.options.snapshot_only) {
    for (const row of rows.rows) {
      const before = row.contact_id;
      const contactId = await ensureContactForRow({
        tenantId: params.tenantId,
        userId: params.userId,
        row,
        updateExisting: Boolean(params.options.update_existing),
        saveNew: Boolean(params.options.save_new_contacts),
      });
      if (!before && contactId) savedContacts += 1;
      if (contactId && contactId !== row.contact_id) {
        await query(
          `UPDATE campaign_recipient_import_rows SET contact_id = $3 WHERE id = $1 AND tenant_id = $2`,
          [row.id, params.tenantId, contactId]
        );
      }
    }
  }

  await query(
    `UPDATE campaign_recipient_imports
     SET status = 'APPLIED', options = $3::jsonb, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND tenant_id = $2`,
    [params.importId, params.tenantId, JSON.stringify(params.options)]
  );

  return { import_id: params.importId, valid_rows: rows.rows.length, saved_contacts: savedContacts };
}

export async function getImportRowsForCampaign(tenantId: number, importId: number) {
  const result = await query(
    `SELECT * FROM campaign_recipient_import_rows
     WHERE import_id = $1 AND tenant_id = $2 AND status IN ('VALID', 'EXISTING_CONTACT')
     ORDER BY row_number`,
    [importId, tenantId]
  );
  return result.rows;
}
