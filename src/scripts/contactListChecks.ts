/**
 * Contact list logic checks (no DB).
 * Run: npx ts-node src/scripts/contactListChecks.ts
 */
import assert from 'assert';
import {
  buildContactListSampleCsv,
  parsePermissionCell,
} from '../services/contactListService';

assert.strictEqual(parsePermissionCell(''), 'UNKNOWN', 'blank permission stays unknown');
assert.strictEqual(parsePermissionCell('evet'), 'OPTED_IN', 'evet => opted in');
assert.strictEqual(parsePermissionCell('hayır'), 'OPTED_OUT', 'hayir => opted out');
assert.strictEqual(parsePermissionCell('  '), 'UNKNOWN', 'whitespace => unknown');

const sample = buildContactListSampleCsv().toString('utf8');
assert.ok(sample.includes('Kurum / Kişi adı'), 'sample has org column');
assert.ok(sample.includes('E-posta izni'), 'sample has email permission column');
assert.ok(sample.includes('WhatsApp izni'), 'sample has whatsapp permission column');

console.log('✓ contactListChecks passed');
