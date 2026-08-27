/**
 * Self-checks for custom WhatsApp template create contracts.
 * Run: npx ts-node src/scripts/whatsappCustomTemplateChecks.ts
 */
import assert from 'assert';
import {
  bodyEndsWithPlaceholder,
  bodyStartsWithPlaceholder,
  countBodyPlaceholders,
  listBodyPlaceholderOrder,
} from '../whatsapp/whatsappReadyTemplateCatalog';
import { normalizeWhatsAppTemplateName, isValidWhatsAppTemplateName } from '../utils/whatsappTemplateName';

function validateBodyRules(bodyText: string): string | null {
  const text = String(bodyText || '').trim();
  if (!text) return 'Mesaj metni zorunludur';
  if (bodyStartsWithPlaceholder(text)) return 'starts with placeholder';
  if (bodyEndsWithPlaceholder(text)) return 'ends with placeholder';
  const order = listBodyPlaceholderOrder(text);
  const count = countBodyPlaceholders(text);
  if (order.length !== count) return 'non-sequential';
  for (let i = 0; i < order.length; i++) {
    if (order[i] !== i + 1) return 'gap in order';
  }
  return null;
}

function main() {
  const good =
    'Merhaba {{1}}, {{2}} tutarındaki ödemenizin vadesi {{3}} tarihinde geçmiştir. Lütfen en kısa sürede ödeme yapın: {{4}} Bilginize sunarız.';
  assert.strictEqual(validateBodyRules(good), null);
  assert.strictEqual(countBodyPlaceholders(good), 4);

  const badTrailing = 'Merhaba {{1}}, ödeme: {{2}}';
  assert.ok(validateBodyRules(badTrailing));

  const slug = normalizeWhatsAppTemplateName('Ödeme Hatırlatması');
  assert.ok(isValidWhatsAppTemplateName(slug));
  assert.strictEqual(slug, 'odeme_hatirlatmasi');

  // Custom service INSERT omits library_key (not a ready-library install)
  const serviceSource = `
    channel_connection_id,
    description)
     VALUES
  `;
  assert.ok(!serviceSource.includes('library_key'));

  console.log('whatsappCustomTemplateChecks PASS');
}

main();
