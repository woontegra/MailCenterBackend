/**
 * WhatsApp bulk campaign logic checks (no DB).
 * Run: npx ts-node src/scripts/whatsappBulkCampaignChecks.ts
 */
import assert from 'assert';
import {
  buildWhatsAppBulkSampleCsv,
  normalizeTurkishPastePhone,
} from '../services/whatsappBulkCampaignService';
import { humanizeRecipientBlock } from '../utils/humanizeEligibility';

function applyMapping(mapping: Record<string, string>, fields: Record<string, string>) {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const [varName, fieldKey] of Object.entries(mapping)) {
    const val = String(fields[fieldKey] ?? '').trim();
    values[varName] = val;
    if (!val) missing.push(varName);
  }
  return { values, missing };
}

const tr1 = normalizeTurkishPastePhone('05323171755');
assert.ok(tr1.ok && tr1.normalized === '+905323171755', 'TR mobile normalize');

const tr2 = normalizeTurkishPastePhone('+90 532 317 17 55');
assert.ok(tr2.ok && tr2.normalized === '+905323171755', 'E.164 TR normalize');

assert.strictEqual(humanizeRecipientBlock('OPTED_OUT'), 'Mesaj almak istemiyor');
assert.strictEqual(humanizeRecipientBlock('UNKNOWN_PREFERENCE'), 'İletişim izni yok');
assert.ok(!humanizeRecipientBlock('INVALID_ADDRESS').includes('OPTED'));

const mapped = applyMapping({ ad: 'ad', firma: 'firma' }, { ad: 'Ali', firma: '' });
assert.deepStrictEqual(mapped.missing, ['firma']);

const sample = buildWhatsAppBulkSampleCsv().toString('utf8');
assert.ok(sample.includes('Telefon'), 'sample csv has Telefon header');

console.log('✓ whatsappBulkCampaignChecks passed');
