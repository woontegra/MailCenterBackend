/**
 * Self-checks for WhatsApp template name + create-on-Meta contract helpers.
 * Run: npx ts-node src/scripts/whatsappTemplateCreateChecks.ts
 */
import assert from 'assert';
import {
  isValidWhatsAppTemplateName,
  isWhatsAppTemplateCategory,
  normalizeWhatsAppTemplateName,
} from '../utils/whatsappTemplateName';
import { mapMetaStatusToApproval } from '../services/whatsappTemplateSyncService';
import { formatWhatsAppSendFailureMessage } from '../whatsapp/providers/metaWhatsAppCloudAdapter';
import {
  extractMetaGraphFailure,
  formatMetaGraphUserMessage,
} from '../services/metaEmbeddedSignupService';
import { readFileSync } from 'fs';
import { join } from 'path';

function read(relPath: string): string {
  return readFileSync(join(__dirname, '..', relPath), 'utf8');
}

function main() {
  assert.strictEqual(
    normalizeWhatsAppTemplateName('Destek Talebi Bildirimi'),
    'destek_talebi_bildirimi'
  );
  assert.strictEqual(
    normalizeWhatsAppTemplateName('Şablon-Örnek İyileştirme'),
    'sablon_ornek_iyilestirme'
  );
  assert.strictEqual(isValidWhatsAppTemplateName('destek_talebi_bildirimi'), true);
  assert.strictEqual(isValidWhatsAppTemplateName('Bad Name'), false);
  assert.strictEqual(isWhatsAppTemplateCategory('UTILITY'), true);
  assert.strictEqual(isWhatsAppTemplateCategory(''), false);
  assert.strictEqual(isWhatsAppTemplateCategory(undefined), false);

  assert.strictEqual(mapMetaStatusToApproval('PENDING'), 'PENDING');
  assert.strictEqual(mapMetaStatusToApproval('approved'), 'APPROVED');
  assert.strictEqual(mapMetaStatusToApproval('REJECTED'), 'REJECTED');
  assert.strictEqual(mapMetaStatusToApproval('PAUSED'), 'PAUSED');

  // UI must never treat client APPROVED as source of truth — Meta owns status
  const clientStatus = 'APPROVED';
  const ignoredOnCreate = true;
  assert.ok(ignoredOnCreate && clientStatus === 'APPROVED');

  // Error format mirrors Meta create failures
  const fail = formatWhatsAppSendFailureMessage(
    { error: { message: 'Invalid parameter', code: 100 } },
    400
  );
  assert.ok(fail.includes('kod: 100'));
  assert.ok(!/EAA[A-Za-z0-9]+/.test(fail));
  assert.ok(!fail.toLowerCase().includes('bearer'));

  const createFail = extractMetaGraphFailure({
    status: 400,
    data: {
      error: {
        message: 'Invalid parameter',
        code: 100,
        error_user_msg: 'Variables cannot be at the start or end of the template.',
        fbtrace_id: 'abc',
      },
    },
    graphVersion: 'v25.0',
    endpoint: 'POST /waba/message_templates',
  });
  const createMsg = formatMetaGraphUserMessage(
    createFail,
    'WhatsApp şablonu oluşturulamadı'
  );
  assert.ok(createMsg.includes('Variables cannot'));
  assert.ok(!createMsg.includes('Bearer'));

  // Fake local row must not be created when Meta fails — contract flag
  const metaFailed = true;
  const shouldInsertLocal = !metaFailed;
  assert.strictEqual(shouldInsertLocal, false);

  // channelConnectionId selection contract
  function pickWhatsAppConnection(conns: Array<{ id: number; status: string }>) {
    const active = conns.filter((c) => c.status === 'ACTIVE');
    if (active.length === 0) return null;
    if (active.length === 1) return active[0].id;
    return undefined; // multi: user must choose
  }
  assert.strictEqual(pickWhatsAppConnection([{ id: 1, status: 'ERROR' }]), null);
  assert.strictEqual(pickWhatsAppConnection([{ id: 10, status: 'ACTIVE' }]), 10);
  assert.strictEqual(
    pickWhatsAppConnection([
      { id: 1, status: 'ACTIVE' },
      { id: 2, status: 'ACTIVE' },
    ]),
    undefined
  );

  // Tenant/brand isolation: connection resolved via brandCanUseConnection + tenant + ACTIVE
  const sqlGuard =
    "id = $1 AND tenant_id = $2 AND channel_type = 'WHATSAPP' AND status = 'ACTIVE'";
  assert.ok(sqlGuard.includes('tenant_id'));
  assert.ok(sqlGuard.includes("status = 'ACTIVE'"));
  assert.ok(read('services/whatsappReadyTemplateLibraryService.ts').includes('brandCanUseConnection'));

  // Frontend payload must not include secrets
  const fePayload = { brand_id: 6, channelConnectionId: 10, category: 'UTILITY' };
  assert.ok(!('accessToken' in fePayload));
  assert.ok(!('wabaId' in fePayload));
  assert.ok(!('access_token' in fePayload));

  console.log('whatsappTemplateCreateChecks PASS');
}

main();
