import { getClient, query } from '../config/database';
import { normalizeContactPointValue, getTenantDefaultCountryCode } from '../utils/contactNormalize';
import { isValidEmailAddress, normalizeEmailAddress } from './suppressionService';
import { parsePermissionCell } from './contactListService';
import { parseContactListFile } from './contactListFileParser';
import {
  detectImportMapping,
  mergeImportMapping,
  type ListImportMapping,
} from './contactListImportMapping';

export type { ListImportMapping };
export { detectImportMapping, mergeImportMapping, parseContactListFile };

function cell(row: Record<string, string>, key?: string) {
  if (!key) return '';
  return String(row[key] ?? '').trim();
}

function splitContactName(full: string) {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  return { first_name: parts[0] || '', last_name: parts.slice(1).join(' ') };
}

export async function previewContactListImport(params: {
  tenantId: number;
  listId: number;
  userId: number;
  filename: string;
  rows: Record<string, string>[];
  mapping: ListImportMapping;
}) {
  const list = await query(
    `SELECT id FROM contact_lists WHERE id = $1 AND tenant_id = $2`,
    [params.listId, params.tenantId]
  );
  if (list.rows.length === 0) throw Object.assign(new Error('Liste bulunamadı'), { status: 404 });

  const countryCode = (await getTenantDefaultCountryCode(params.tenantId)) || '90';

  const mapped = [];
  const seenEmail = new Set<string>();
  const seenPhone = new Set<string>();

  for (let idx = 0; idx < params.rows.length; idx += 1) {
    const row = params.rows[idx];
    const org = cell(row, params.mapping.organization_name);
    let first = cell(row, params.mapping.first_name);
    let last = cell(row, params.mapping.last_name);
    const contactName = cell(row, params.mapping.contact_name);
    if (!first && !last && contactName) {
      const split = splitContactName(contactName);
      first = split.first_name;
      last = split.last_name;
    }
    const emailRaw = cell(row, params.mapping.email);
    const phoneRaw = cell(row, params.mapping.phone);
    const emailNorm = emailRaw ? normalizeEmailAddress(emailRaw) : '';
    let phoneNorm = '';
    if (phoneRaw) {
      const phone = await normalizeContactPointValue({
        tenantId: params.tenantId,
        channelType: 'WHATSAPP',
        value: phoneRaw,
        countryCode,
      });
      if (phone.ok) phoneNorm = phone.normalized;
    }

    let status = 'VALID';
    let message = '';

    if (!emailNorm && !phoneNorm) {
      status = 'MISSING_CONTACT';
      message = 'E-posta veya telefon gerekli';
    } else if (emailNorm && !isValidEmailAddress(emailNorm)) {
      status = 'INVALID_EMAIL';
      message = 'Geçersiz e-posta';
    } else if (phoneRaw && !phoneNorm) {
      status = 'INVALID_PHONE';
      message = 'Geçersiz telefon';
    } else {
      const dedupeKey = emailNorm || phoneNorm;
      const seenSet = emailNorm ? seenEmail : seenPhone;
      if (seenSet.has(dedupeKey)) {
        status = 'DUPLICATE_IN_FILE';
        message = 'Dosyada mükerrer';
      } else {
        seenSet.add(dedupeKey);
      }
    }

    mapped.push({
      row_number: idx + 2,
      raw_data: row,
      organization_name: org,
      first_name: first,
      last_name: last,
      email: emailRaw,
      email_normalized: emailNorm,
      phone: phoneRaw,
      phone_normalized: phoneNorm,
      city: cell(row, params.mapping.city),
      notes: cell(row, params.mapping.notes),
      email_permission: parsePermissionCell(cell(row, params.mapping.email_permission)),
      whatsapp_permission: parsePermissionCell(cell(row, params.mapping.whatsapp_permission)),
      status,
      message,
    });
  }

  const existingEmails = mapped.filter((r) => r.email_normalized).map((r) => r.email_normalized);
  const existingPhones = mapped.filter((r) => r.phone_normalized).map((r) => r.phone_normalized);

  const emailMatches = existingEmails.length
    ? await query(
        `SELECT cp.normalized_value, c.id AS contact_id
         FROM contact_points cp
         JOIN contacts c ON c.id = cp.contact_id AND c.tenant_id = cp.tenant_id
         WHERE cp.tenant_id = $1 AND cp.channel_type = 'EMAIL'
           AND cp.normalized_value = ANY($2::text[]) AND cp.is_active = true`,
        [params.tenantId, existingEmails]
      )
    : { rows: [] as any[] };

  const phoneMatches = existingPhones.length
    ? await query(
        `SELECT cp.normalized_value, c.id AS contact_id
         FROM contact_points cp
         JOIN contacts c ON c.id = cp.contact_id AND c.tenant_id = cp.tenant_id
         WHERE cp.tenant_id = $1 AND cp.channel_type IN ('WHATSAPP', 'SMS')
           AND cp.normalized_value = ANY($2::text[]) AND cp.is_active = true`,
        [params.tenantId, existingPhones]
      )
    : { rows: [] as any[] };

  const emailByNorm = new Map<string, number>();
  for (const r of emailMatches.rows) emailByNorm.set(r.normalized_value, Number(r.contact_id));
  const phoneByNorm = new Map<string, number>();
  for (const r of phoneMatches.rows) phoneByNorm.set(r.normalized_value, Number(r.contact_id));

  let valid = 0;
  let invalid = 0;
  let duplicate = 0;
  let existing = 0;
  let newContacts = 0;

  for (const row of mapped) {
    if (row.status === 'VALID') {
      const existingId =
        (row.email_normalized && emailByNorm.get(row.email_normalized)) ||
        (row.phone_normalized && phoneByNorm.get(row.phone_normalized)) ||
        null;
      if (existingId) {
        row.status = 'EXISTING_CONTACT';
        row.contact_id = existingId;
        existing += 1;
      } else {
        row.status = 'NEW_CONTACT';
        newContacts += 1;
      }
      valid += 1;
    } else if (row.status === 'DUPLICATE_IN_FILE') duplicate += 1;
    else invalid += 1;
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const importRes = await client.query(
      `INSERT INTO contact_list_imports (tenant_id, list_id, filename, status, summary, created_by)
       VALUES ($1, $2, $3, 'PREVIEW', $4::jsonb, $5)
       RETURNING id`,
      [
        params.tenantId,
        params.listId,
        params.filename,
        JSON.stringify({
          total_rows: mapped.length,
          valid_rows: valid,
          invalid_rows: invalid,
          duplicate_rows: duplicate,
          existing_contacts: existing,
          new_contacts: newContacts,
        }),
        params.userId,
      ]
    );
    const importId = importRes.rows[0].id;

    for (const row of mapped) {
      await client.query(
        `INSERT INTO contact_list_import_rows (
           import_id, tenant_id, row_number, raw_data, status, contact_id, message
         ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
        [
          importId,
          params.tenantId,
          row.row_number,
          JSON.stringify({
            ...row,
            raw_data: row.raw_data,
          }),
          row.status,
          row.contact_id || null,
          row.message || null,
        ]
      );
    }
    await client.query('COMMIT');

    return {
      import_id: importId,
      summary: {
        total_rows: mapped.length,
        valid_rows: valid,
        invalid_rows: invalid,
        duplicate_rows: duplicate,
        existing_contacts: existing,
        new_contacts: newContacts,
      },
      rows: mapped.map((r) => ({
        row_number: r.row_number,
        status: r.status,
        message: r.message,
        email: r.email,
        phone: r.phone,
        organization_name: r.organization_name,
      })),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function enrichExistingContact(
  client: any,
  params: {
    tenantId: number;
    contactId: number;
    organizationName: string;
    firstName: string;
    lastName: string;
    notes: string;
    city: string;
  }
) {
  const cur = await client.query(
    `SELECT first_name, last_name, company_name, notes
     FROM contacts WHERE id = $1 AND tenant_id = $2`,
    [params.contactId, params.tenantId]
  );
  if (cur.rows.length === 0) return;

  const row = cur.rows[0];
  const fields: string[] = [];
  const values: unknown[] = [params.contactId, params.tenantId];

  const setIfEmpty = (column: string, current: unknown, next: string) => {
    if (String(current || '').trim()) return;
    if (!String(next || '').trim()) return;
    values.push(next.trim());
    fields.push(`${column} = $${values.length}`);
  };

  setIfEmpty('company_name', row.company_name, params.organizationName);
  setIfEmpty('first_name', row.first_name, params.firstName);
  setIfEmpty('last_name', row.last_name, params.lastName);

  const noteParts = [params.city, params.notes].filter((v) => String(v || '').trim());
  const combinedNotes = noteParts.join(' — ');
  if (combinedNotes) {
    const existingNotes = String(row.notes || '').trim();
    if (!existingNotes) {
      values.push(combinedNotes);
      fields.push(`notes = $${values.length}`);
    }
  }

  if (fields.length === 0) return;
  fields.push('updated_at = CURRENT_TIMESTAMP');
  await client.query(
    `UPDATE contacts SET ${fields.join(', ')} WHERE id = $1 AND tenant_id = $2`,
    values
  );
}

async function upsertPreference(
  client: any,
  params: {
    tenantId: number;
    contactId: number;
    channelType: 'EMAIL' | 'WHATSAPP';
    status: 'OPTED_IN' | 'OPTED_OUT' | 'UNKNOWN';
    userId: number;
  }
) {
  if (params.status === 'UNKNOWN') return;
  await client.query(
    `INSERT INTO communication_preferences (
       tenant_id, contact_id, brand_id, channel_type, status, source, updated_by
     ) VALUES ($1, $2, NULL, $3, $4, 'import_explicit', $5)
     ON CONFLICT (tenant_id, contact_id, COALESCE(brand_id, 0), channel_type)
     DO UPDATE SET status = EXCLUDED.status, source = EXCLUDED.source,
                   updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
    [params.tenantId, params.contactId, params.channelType, params.status, params.userId]
  );
}

export async function applyContactListImport(params: {
  tenantId: number;
  listId: number;
  importId: number;
  userId: number;
}) {
  const importRes = await query(
    `SELECT * FROM contact_list_imports
     WHERE id = $1 AND tenant_id = $2 AND list_id = $3 AND status = 'PREVIEW'`,
    [params.importId, params.tenantId, params.listId]
  );
  if (importRes.rows.length === 0) return null;

  const rowsRes = await query(
    `SELECT * FROM contact_list_import_rows
     WHERE import_id = $1 AND tenant_id = $2
       AND status IN ('NEW_CONTACT', 'EXISTING_CONTACT')
     ORDER BY row_number`,
    [params.importId, params.tenantId]
  );

  const cc = (await getTenantDefaultCountryCode(params.tenantId)) || '90';

  const client = await getClient();
  let addedToList = 0;
  let createdContacts = 0;

  try {
    await client.query('BEGIN');

    for (const dbRow of rowsRes.rows) {
      const data = typeof dbRow.raw_data === 'object' ? dbRow.raw_data : JSON.parse(dbRow.raw_data);
      let contactId = dbRow.contact_id ? Number(dbRow.contact_id) : null;

      if (!contactId) {
        const ins = await client.query(
          `INSERT INTO contacts (tenant_id, first_name, last_name, company_name, notes, status, created_by)
           VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6)
           RETURNING id`,
          [
            params.tenantId,
            data.first_name || null,
            data.last_name || null,
            data.organization_name || null,
            data.notes || data.city ? [data.city, data.notes].filter(Boolean).join(' — ') : null,
            params.userId,
          ]
        );
        contactId = Number(ins.rows[0].id);
        createdContacts += 1;

        if (data.email_normalized) {
          const emailPoint = await normalizeContactPointValue({
            tenantId: params.tenantId,
            channelType: 'EMAIL',
            value: data.email,
            countryCode: null,
          });
          if (emailPoint.ok) {
            await client.query(
              `INSERT INTO contact_points (tenant_id, contact_id, channel_type, value, normalized_value, is_primary, is_active)
               VALUES ($1, $2, 'EMAIL', $3, $4, true, true)
               ON CONFLICT (tenant_id, channel_type, normalized_value) DO NOTHING`,
              [params.tenantId, contactId, emailPoint.value, emailPoint.normalized]
            );
          }
        }
        if (data.phone_normalized) {
          await client.query(
            `INSERT INTO contact_points (tenant_id, contact_id, channel_type, value, normalized_value, is_primary, is_active)
             VALUES ($1, $2, 'WHATSAPP', $3, $4, true, true)
             ON CONFLICT (tenant_id, channel_type, normalized_value) DO NOTHING`,
            [params.tenantId, contactId, data.phone_normalized, data.phone_normalized]
          );
        }
      } else {
        await enrichExistingContact(client, {
          tenantId: params.tenantId,
          contactId,
          organizationName: String(data.organization_name || ''),
          firstName: String(data.first_name || ''),
          lastName: String(data.last_name || ''),
          notes: String(data.notes || ''),
          city: String(data.city || ''),
        });
      }

      if (data.email_permission && data.email_permission !== 'UNKNOWN') {
        await upsertPreference(client, {
          tenantId: params.tenantId,
          contactId,
          channelType: 'EMAIL',
          status: data.email_permission,
          userId: params.userId,
        });
      }
      if (data.whatsapp_permission && data.whatsapp_permission !== 'UNKNOWN') {
        await upsertPreference(client, {
          tenantId: params.tenantId,
          contactId,
          channelType: 'WHATSAPP',
          status: data.whatsapp_permission,
          userId: params.userId,
        });
      }

      const member = await client.query(
        `INSERT INTO contact_list_members (tenant_id, list_id, contact_id, added_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, list_id, contact_id) DO NOTHING
         RETURNING id`,
        [params.tenantId, params.listId, contactId, params.userId]
      );
      if (member.rows.length > 0) addedToList += 1;

      await client.query(
        `UPDATE contact_list_import_rows SET status = 'APPLIED', contact_id = $3
         WHERE id = $1 AND tenant_id = $2`,
        [dbRow.id, params.tenantId, contactId]
      );
    }

    await client.query(
      `UPDATE contact_lists
       SET member_count = (
         SELECT COUNT(*)::int FROM contact_list_members WHERE tenant_id = $1 AND list_id = $2
       ), updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND tenant_id = $1`,
      [params.tenantId, params.listId]
    );

    await client.query(
      `UPDATE contact_list_imports SET status = 'APPLIED' WHERE id = $1 AND tenant_id = $2`,
      [params.importId, params.tenantId]
    );

    await client.query('COMMIT');
    return { added_to_list: addedToList, created_contacts: createdContacts };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function exportContactListImportResults(
  tenantId: number,
  importId: number
): Promise<Buffer> {
  const XLSX = await import('xlsx');
  const rows = await query(
    `SELECT row_number, status, message, raw_data
     FROM contact_list_import_rows
     WHERE import_id = $1 AND tenant_id = $2
     ORDER BY row_number`,
    [importId, tenantId]
  );

  const sheetRows = rows.rows.map((r: any) => {
    const data = typeof r.raw_data === 'object' ? r.raw_data : JSON.parse(r.raw_data || '{}');
    return {
      Satır: r.row_number,
      Durum: r.status,
      Açıklama: r.message || '',
      Kurum: data.organization_name || '',
      'Yetkili adı': [data.first_name, data.last_name].filter(Boolean).join(' '),
      Eposta: data.email || '',
      Telefon: data.phone || '',
    };
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(sheetRows);
  XLSX.utils.book_append_sheet(wb, ws, 'Import sonuçları');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
