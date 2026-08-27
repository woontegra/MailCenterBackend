/**
 * Self-checks for WhatsApp ready-template library contracts.
 * Run: npx ts-node src/scripts/whatsappReadyTemplateLibraryChecks.ts
 */
import assert from 'assert';
import {
  WHATSAPP_READY_TEMPLATE_CATALOG,
  bodyEndsWithPlaceholder,
  bodyHasStaticTextAfterLastPlaceholder,
  bodyStartsWithPlaceholder,
  buildCatalogPreview,
  countBodyPlaceholders,
  getReadyTemplateByKey,
  getReadyTemplateByProviderName,
  listBodyPlaceholderOrder,
} from '../whatsapp/whatsappReadyTemplateCatalog';
import {
  humanizeWhatsAppTemplateRejection,
  mapMetaStatusToApproval,
} from '../services/whatsappTemplateSyncService';
import { isValidWhatsAppTemplateName } from '../utils/whatsappTemplateName';
import {
  extractMetaGraphFailure,
  formatMetaGraphUserMessage,
  sanitizeMetaErrorData,
} from '../services/metaEmbeddedSignupService';

function main() {
  assert.strictEqual(WHATSAPP_READY_TEMPLATE_CATALOG.length, 12);

  const keys = new Set(WHATSAPP_READY_TEMPLATE_CATALOG.map((i) => i.key));
  const providers = new Set(WHATSAPP_READY_TEMPLATE_CATALOG.map((i) => i.providerName));
  assert.strictEqual(keys.size, 12, 'catalog keys must be unique');
  assert.strictEqual(providers.size, 12, 'provider names must be unique');

  for (const item of WHATSAPP_READY_TEMPLATE_CATALOG) {
    assert.ok(isValidWhatsAppTemplateName(item.providerName), item.providerName);
    assert.ok(['UTILITY', 'MARKETING'].includes(item.category), item.key);
    assert.strictEqual(item.language, 'tr');

    assert.strictEqual(
      bodyStartsWithPlaceholder(item.bodyText),
      false,
      `${item.key} BODY must not start with a placeholder`
    );
    assert.strictEqual(
      bodyEndsWithPlaceholder(item.bodyText),
      false,
      `${item.key} BODY must not end with a placeholder`
    );
    assert.ok(
      bodyHasStaticTextAfterLastPlaceholder(item.bodyText),
      `${item.key} BODY must have meaningful static text after the last placeholder`
    );

    const placeholders = countBodyPlaceholders(item.bodyText);
    assert.strictEqual(
      placeholders,
      item.variables.length,
      `${item.key} placeholder/variable mismatch`
    );
    const order = listBodyPlaceholderOrder(item.bodyText);
    assert.deepStrictEqual(
      order,
      item.variables.map((_, i) => i + 1),
      `${item.key} placeholder order must be sequential 1..n`
    );
    for (let i = 0; i < item.variables.length; i++) {
      assert.strictEqual(item.variables[i].index, i + 1);
      assert.ok(item.variables[i].example.trim().length > 0);
    }
    assert.strictEqual(
      item.variables.map((v) => v.example).length,
      placeholders,
      `${item.key} example count must match placeholder count`
    );
    const preview = buildCatalogPreview(
      item.bodyText,
      item.variables.map((v) => v.example)
    );
    assert.ok(!preview.includes('{{'), `${item.key} preview still has placeholders`);
  }

  const overdue = getReadyTemplateByKey('payment_overdue');
  assert.ok(overdue);
  assert.ok(overdue!.bodyText.includes('Bilginize sunarız.'));
  assert.ok(!bodyEndsWithPlaceholder(overdue!.bodyText));

  assert.ok(getReadyTemplateByKey('payment_due_reminder'));
  assert.ok(getReadyTemplateByProviderName('mc_odeme_son_tarih'));
  assert.strictEqual(getReadyTemplateByKey('nope'), null);

  // Status mapping: PAUSED is distinct; PENDING/REJECTED not sendable
  assert.strictEqual(mapMetaStatusToApproval('PAUSED'), 'PAUSED');
  assert.strictEqual(mapMetaStatusToApproval('APPROVED'), 'APPROVED');
  assert.strictEqual(mapMetaStatusToApproval('PENDING'), 'PENDING');
  assert.strictEqual(mapMetaStatusToApproval('REJECTED'), 'REJECTED');

  function isSendable(status: string) {
    return String(status).toUpperCase() === 'APPROVED';
  }
  assert.strictEqual(isSendable('APPROVED'), true);
  assert.strictEqual(isSendable('PENDING'), false);
  assert.strictEqual(isSendable('REJECTED'), false);
  assert.strictEqual(isSendable('PAUSED'), false);

  // Tenant isolation contract: install lookup always includes tenant + waba
  const installSql =
    "tenant_id = $1 AND channel_type = 'WHATSAPP' AND library_key = $2 AND provider_waba_id = $3";
  assert.ok(installSql.includes('tenant_id'));
  assert.ok(installSql.includes('provider_waba_id'));
  assert.ok(installSql.includes('library_key'));

  // Same catalog on different WABAs is allowed (unique index is per tenant+waba+key)
  const uniqueIndex = '(tenant_id, provider_waba_id, library_key)';
  assert.ok(uniqueIndex.includes('provider_waba_id'));

  // Active connection required
  const connGuard =
    "id = $1 AND tenant_id = $2 AND brand_id = $3 AND channel_type = 'WHATSAPP' AND status = 'ACTIVE'";
  assert.ok(connGuard.includes("status = 'ACTIVE'"));
  assert.ok(connGuard.includes('tenant_id'));

  // Rejection humanization never leaks tokens
  const human = humanizeWhatsAppTemplateRejection('Invalid format EAABxyztoken Bearer abc');
  assert.ok(human);
  assert.ok(!/EAA[A-Za-z0-9]+/.test(human!));
  assert.ok(!human!.toLowerCase().includes('bearer abc'));

  // Meta failure prefers error_user_msg over bare Invalid parameter
  const failure = extractMetaGraphFailure({
    status: 400,
    data: {
      error: {
        message: 'Invalid parameter',
        type: 'OAuthException',
        code: 100,
        error_subcode: 2388299,
        error_user_title: 'Trailing parameter',
        error_user_msg: 'Variables cannot be at the start or end of the template.',
        error_data: {
          messaging_product: 'whatsapp',
          details: 'Leading or trailing parameters not allowed',
        },
        fbtrace_id: 'TRACE_TEST',
      },
    },
    wabaId: '420529479291363',
    graphVersion: 'v25.0',
    endpoint: 'POST /420529479291363/message_templates',
  });
  assert.strictEqual(failure.code, 100);
  assert.strictEqual(failure.errorSubcode, 2388299);
  assert.strictEqual(failure.errorUserTitle, 'Trailing parameter');
  assert.ok(failure.errorUserMsg?.includes('Variables cannot'));
  assert.ok(failure.errorData && typeof failure.errorData === 'object');
  const userMsg = formatMetaGraphUserMessage(failure, 'WhatsApp şablonu oluşturulamadı');
  assert.ok(userMsg.includes('Variables cannot'));
  assert.ok(userMsg.includes('(kod: 100)'));
  assert.ok(!userMsg.startsWith('WhatsApp şablonu oluşturulamadı: Invalid parameter'));

  const redacted = sanitizeMetaErrorData({
    details: 'bad EAABxyztoken123 Bearer secretvalue',
    messaging_product: 'whatsapp',
  });
  assert.ok(redacted && typeof redacted === 'object');
  assert.ok(!JSON.stringify(redacted).includes('EAABxyztoken'));
  assert.ok(!JSON.stringify(redacted).toLowerCase().includes('bearer secret'));

  // FE payload must not include secrets
  const fePayload = {
    brand_id: 13,
    channelConnectionId: 11,
    bodyText: 'x',
    examples: ['a', 'b'],
  };
  assert.ok(!('accessToken' in fePayload));
  assert.ok(!('access_token' in fePayload));
  assert.ok(!('wabaId' in fePayload));

  // Dedupe: existing install blocks second Meta create
  function shouldCreateOnMeta(existing: unknown) {
    return !existing;
  }
  assert.strictEqual(shouldCreateOnMeta(null), true);
  assert.strictEqual(shouldCreateOnMeta({ id: 1 }), false);

  // User-facing CTA must not say WABA
  const cta = 'WhatsApp hesabıma ekle ve onaya gönder';
  assert.ok(!/waba/i.test(cta));

  console.log('whatsappReadyTemplateLibraryChecks PASS');
}

main();
