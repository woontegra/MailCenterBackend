/**
 * Contact list logic checks (no DB).
 * Run: npx ts-node src/scripts/contactListChecks.ts
 */
import assert from 'assert';
import {
  buildContactListSampleCsv,
  buildContactListSampleXlsx,
  parsePermissionCell,
} from '../services/contactListService';

assert.strictEqual(parsePermissionCell(''), 'UNKNOWN', 'blank permission stays unknown');
assert.strictEqual(parsePermissionCell('evet'), 'OPTED_IN', 'evet => opted in');
assert.strictEqual(parsePermissionCell('hayır'), 'OPTED_OUT', 'hayir => opted out');
assert.strictEqual(parsePermissionCell('  '), 'UNKNOWN', 'whitespace => unknown');

const sample = buildContactListSampleCsv().toString('utf8');
assert.ok(sample.startsWith('\uFEFF'), 'sample csv has utf8 bom');
assert.ok(sample.includes('Kurum / Kişi Adı'), 'sample has org column');
assert.ok(sample.includes('E-posta İzni'), 'sample has email permission column');
assert.ok(sample.includes('WhatsApp İzni'), 'sample has whatsapp permission column');
assert.ok(sample.includes(';'), 'sample csv uses semicolon delimiter');

const xlsx = buildContactListSampleXlsx();
assert.ok(xlsx.length > 50, 'sample xlsx generated');

console.log('✓ contactListChecks passed');
