/**
 * Read-only dry-run report for fixing Barolar list contacts with empty names.
 * Does NOT modify live data.
 * Run: npx ts-node src/scripts/barolarImportFixDryRun.ts
 */
import 'dotenv/config';
import { query } from '../config/database';
import { detectImportMapping } from '../services/contactListImportMapping';

const ORG_HEADER_CANDIDATES = [
  'Ad Soyad / Kurum Adı',
  'Kurum / Kişi Adı',
  'Baro Adı',
  'Kurum Adı',
];

function extractOrgName(rawData: Record<string, unknown>): string {
  if (!rawData || typeof rawData !== 'object') return '';
  const nested =
    rawData.raw_data && typeof rawData.raw_data === 'object'
      ? (rawData.raw_data as Record<string, string>)
      : null;
  const source = nested || (rawData as Record<string, string>);

  const direct = String(rawData.organization_name || '').trim();
  if (direct) return direct;

  const headers = Object.keys(source);
  const detected = detectImportMapping(headers);
  if (detected.organization_name) {
    const value = String(source[detected.organization_name] || '').trim();
    if (value) return value;
  }

  for (const candidate of ORG_HEADER_CANDIDATES) {
    const value = String(source[candidate] || '').trim();
    if (value) return value;
  }

  for (const header of headers) {
    if (/baro|kurum|firma|unvan|ad soyad/i.test(header)) {
      const value = String(source[header] || '').trim();
      if (value) return value;
    }
  }

  return '';
}

async function main() {
  const lists = await query(
    `SELECT id, name, tenant_id, member_count FROM contact_lists WHERE name ILIKE '%baro%' ORDER BY id LIMIT 1`
  );

  const emptyContacts = await query(
    `SELECT COUNT(*)::int AS total
     FROM contacts c
     WHERE COALESCE(TRIM(c.company_name), '') = ''
       AND COALESCE(TRIM(c.first_name), '') = ''
       AND COALESCE(TRIM(c.last_name), '') = ''`
  );

  if (!lists.rows.length) {
    const imports = await query(
      `SELECT id, list_id, filename, status, created_at
       FROM contact_list_imports
       WHERE filename ILIKE '%baro%'
       ORDER BY id DESC
       LIMIT 1`
    );
    console.log('=== Barolar import düzeltme dry-run (READ ONLY) ===');
    console.log('Barolar listesi bulunamadı.');
    console.log(`Boş ad/kurumlu contact sayısı: ${emptyContacts.rows[0]?.total || 0}`);
    if (!imports.rows.length) {
      console.log('contact_list_imports kaydı da bulunamadı; ham import satırından otomatik düzeltme raporu üretilemiyor.');
      console.log('');
      console.log('Bilinen kök neden (önceki import incelemesinden):');
      console.log('- Dosya kolonu: "Ad Soyad / Kurum Adı"');
      console.log('- UI/backend varsayılan eşleme: "Kurum / Kişi adı" → eşleşmedi');
      console.log('- organization_name boş kaldı, contacts.company_name NULL yazıldı');
      console.log('- Bu oturumda import satırları DB\'den silinmiş görünüyor; onaylı düzeltme için dosyayı yeniden import etmek veya yedekten import_rows geri yüklemek gerekir.');
      return;
    }
    console.log(`Son Baro import kaydı: ${imports.rows[0].filename} (#${imports.rows[0].id})`);
  }

  const list = lists.rows[0] || { id: null, name: 'Barolar (liste yok)', tenant_id: null, member_count: 0 };
  const listId = list.id ? Number(list.id) : null;
  const tenantId = list.tenant_id ? Number(list.tenant_id) : null;

  const imports = await query(
    listId && tenantId
      ? `SELECT id, filename, status, created_at
         FROM contact_list_imports
         WHERE list_id = $1 AND tenant_id = $2
         ORDER BY id DESC LIMIT 1`
      : `SELECT id, filename, status, created_at
         FROM contact_list_imports
         WHERE filename ILIKE '%baro%'
         ORDER BY id DESC LIMIT 1`,
    listId && tenantId ? [listId, tenantId] : []
  );
  const importId = imports.rows[0] ? Number(imports.rows[0].id) : null;
  const importTenantId = tenantId || (imports.rows[0] ? Number((imports.rows[0] as any).tenant_id || 0) : 0);

  const members =
    listId && tenantId
      ? await query(
          `SELECT c.id AS contact_id,
                  c.company_name,
                  c.first_name,
                  c.last_name,
                  cp.normalized_value AS email
           FROM contact_list_members clm
           JOIN contacts c ON c.id = clm.contact_id AND c.tenant_id = clm.tenant_id
           LEFT JOIN LATERAL (
             SELECT normalized_value
             FROM contact_points
             WHERE tenant_id = c.tenant_id AND contact_id = c.id
               AND channel_type = 'EMAIL' AND is_active = true
             ORDER BY is_primary DESC, id
             LIMIT 1
           ) cp ON true
           WHERE clm.list_id = $1 AND clm.tenant_id = $2
           ORDER BY c.id`,
          [listId, tenantId]
        )
      : await query(
          `SELECT c.id AS contact_id,
                  c.company_name,
                  c.first_name,
                  c.last_name,
                  cp.normalized_value AS email
           FROM contacts c
           LEFT JOIN LATERAL (
             SELECT normalized_value
             FROM contact_points
             WHERE tenant_id = c.tenant_id AND contact_id = c.id
               AND channel_type = 'EMAIL' AND is_active = true
             ORDER BY is_primary DESC, id
             LIMIT 1
           ) cp ON true
           WHERE COALESCE(TRIM(c.company_name), '') = ''
             AND COALESCE(TRIM(c.first_name), '') = ''
             AND COALESCE(TRIM(c.last_name), '') = ''
           ORDER BY c.id`
        );

  const importRows = importId
    ? await query(
        `SELECT row_number, raw_data
         FROM contact_list_import_rows
         WHERE import_id = $1
         ORDER BY row_number`,
        [importId]
      )
    : { rows: [] as any[] };

  const orgByEmail = new Map<string, string>();
  const ambiguousEmails = new Set<string>();
  const sourceRowsWithOrg = new Set<number>();

  for (const row of importRows.rows) {
    const raw =
      typeof row.raw_data === 'object' ? row.raw_data : JSON.parse(row.raw_data || '{}');
    const email = String(raw.email_normalized || raw.email || '')
      .trim()
      .toLowerCase();
    const org = extractOrgName(raw);
    if (org) sourceRowsWithOrg.add(Number(row.row_number));
    if (!email || !org) continue;

    if (orgByEmail.has(email) && orgByEmail.get(email) !== org) {
      ambiguousEmails.add(email);
      continue;
    }
    orgByEmail.set(email, org);
  }

  let wouldUpdate = 0;
  let alreadyNamed = 0;
  let noSourceMatch = 0;
  let ambiguous = 0;
  let duplicateSource = 0;

  for (const member of members.rows) {
    const email = String(member.email || '').trim().toLowerCase();
    const hasName =
      Boolean(String(member.company_name || '').trim()) ||
      Boolean(String(member.first_name || '').trim()) ||
      Boolean(String(member.last_name || '').trim());

    if (hasName) {
      alreadyNamed += 1;
      continue;
    }

    if (!email) {
      noSourceMatch += 1;
      continue;
    }

    if (ambiguousEmails.has(email)) {
      ambiguous += 1;
      continue;
    }

    const proposed = orgByEmail.get(email);
    if (!proposed) {
      noSourceMatch += 1;
      continue;
    }

    wouldUpdate += 1;
  }

  duplicateSource = ambiguousEmails.size;

  console.log('=== Barolar import düzeltme dry-run (READ ONLY) ===');
  console.log(`Liste: ${list.name} (#${listId}), tenant ${tenantId}, üye ${list.member_count}`);
  console.log(
    `Kaynak import: ${imports.rows[0]?.filename || '—'} (#${importId || '—'}, ${imports.rows[0]?.status || '—'})`
  );
  console.log('');
  console.log('Kök neden:');
  console.log(
    '- Excel kolonu "Ad Soyad / Kurum Adı" idi; UI varsayılan eşleme "Kurum / Kişi adı" ile uyuşmadı.'
  );
  console.log(
    '- Preview/import sırasında organization_name boş kaldı; contacts.company_name NULL yazıldı.'
  );
  console.log(
    `- Import satırlarında kurum adı hâlâ mevcut: ${sourceRowsWithOrg.size}/${importRows.rows.length} satır.`
  );
  console.log('');
  console.log('Dry-run özeti:');
  console.log(`- Toplam liste üyesi: ${members.rows.length}`);
  console.log(`- Zaten ad/kurum dolu: ${alreadyNamed}`);
  console.log(`- E-posta → kurum adı ile güvenli güncellenebilir: ${wouldUpdate}`);
  console.log(`- Kaynak eşleşmesi yok: ${noSourceMatch}`);
  console.log(`- Belirsiz/çakışan e-posta eşlemesi: ${ambiguous}`);
  console.log(`- Kaynakta mükerrer/çelişkili e-posta: ${duplicateSource}`);
  console.log('');
  console.log('Not: Bu script canlı veriyi değiştirmez. Onay olmadan UPDATE/REIMPORT yapmayın.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
