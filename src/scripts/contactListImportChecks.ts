/**
 * Contact list import mapping and file parser checks (no DB).
 * Run: npx ts-node src/scripts/contactListImportChecks.ts
 */
import assert from 'assert';
import * as XLSX from 'xlsx';
import {
  buildContactListSampleCsv,
  buildContactListSampleXlsx,
  formatContactListMemberLabel,
} from '../services/contactListService';
import { parseContactListFile } from '../services/contactListFileParser';
import { detectImportMapping, mergeImportMapping } from '../services/contactListImportMapping';

assert.strictEqual(
  detectImportMapping(['Baro Adı', 'E-posta', 'Şehir']).organization_name,
  'Baro Adı',
  'Baro Adı maps to organization_name'
);

assert.strictEqual(
  detectImportMapping(['Ad Soyad / Kurum Adı', 'E-posta']).organization_name,
  'Ad Soyad / Kurum Adı',
  'Ad Soyad / Kurum Adı maps to organization_name'
);

assert.strictEqual(
  detectImportMapping(['Kurum Adı', 'Mail', 'GSM', 'İl']).email,
  'Mail',
  'Mail maps to email'
);
assert.strictEqual(
  detectImportMapping(['Kurum Adı', 'Mail', 'GSM', 'İl']).phone,
  'GSM',
  'GSM maps to phone'
);
assert.strictEqual(
  detectImportMapping(['Kurum Adı', 'Mail', 'GSM', 'İl']).city,
  'İl',
  'İl maps to city'
);

const merged = mergeImportMapping(
  { organization_name: 'Özel Kolon' },
  detectImportMapping(['Baro Adı', 'E-posta'])
);
assert.strictEqual(merged.organization_name, 'Özel Kolon', 'user mapping overrides detected');
assert.strictEqual(merged.email, 'E-posta', 'detected email kept when user did not override');

assert.strictEqual(
  formatContactListMemberLabel({ company_name: 'Adana Barosu', first_name: null, last_name: null }),
  'Adana Barosu',
  'company shown first'
);
assert.strictEqual(
  formatContactListMemberLabel({ company_name: '', first_name: 'Ali', last_name: 'Yılmaz' }),
  'Ali Yılmaz',
  'person shown when company empty'
);
assert.strictEqual(
  formatContactListMemberLabel({ company_name: '', first_name: '', last_name: '' }),
  'Ad bilgisi yok',
  'fallback label'
);

const csvSample = buildContactListSampleCsv();
const csvText = csvSample.toString('utf8');
assert.ok(csvText.startsWith('\uFEFF'), 'csv sample has utf8 bom');
assert.ok(csvText.includes('Kurum / Kişi Adı'), 'csv sample has org header');
assert.ok(csvText.includes('E-posta İzni'), 'csv sample has email permission header');
assert.ok(csvText.includes(';'), 'csv sample uses semicolon delimiter');
assert.ok(csvText.includes('Örnek Baro'), 'csv sample has example row');

const xlsxSample = buildContactListSampleXlsx();
assert.ok(xlsxSample.length > 100, 'xlsx sample is non-trivial');
const wb = XLSX.read(xlsxSample, { type: 'buffer' });
const sheet = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet);
assert.strictEqual(rows[0]['Kurum / Kişi Adı'], 'Örnek Baro', 'xlsx sample has org example');

const csvParsed = parseContactListFile({
  originalname: 'test.csv',
  buffer: csvSample,
});
assert.strictEqual(csvParsed.file_kind, 'csv', 'csv detected by content');
assert.ok(csvParsed.headers.includes('Kurum / Kişi Adı'), 'csv headers parsed');
assert.strictEqual(csvParsed.rows[0]['Kurum / Kişi Adı'], 'Örnek Baro', 'csv row parsed with turkish chars');

const xlsxParsed = parseContactListFile({
  originalname: 'test.xlsx',
  buffer: xlsxSample,
});
assert.strictEqual(xlsxParsed.file_kind, 'xlsx', 'xlsx detected by content');
assert.ok(xlsxParsed.rows.length >= 1, 'xlsx rows parsed');

const baroCsv = Buffer.from(
  '\uFEFFBaro Adı;E-posta;Şehir\nAdana Barosu;test@ornek.com;Adana\n',
  'utf8'
);
const baroParsed = parseContactListFile({ originalname: 'barolar.csv', buffer: baroCsv });
const baroMapping = detectImportMapping(baroParsed.headers);
assert.strictEqual(baroMapping.organization_name, 'Baro Adı', 'baro csv header detected');
assert.strictEqual(baroParsed.rows[0]['Baro Adı'], 'Adana Barosu', 'baro csv row parsed');

console.log('✓ contactListImportChecks passed');
