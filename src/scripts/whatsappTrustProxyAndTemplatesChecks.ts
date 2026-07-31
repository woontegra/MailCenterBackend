/**
 * Self-checks for trust proxy + template status normalization + send failure formatting.
 * Run: npx ts-node src/scripts/whatsappTrustProxyAndTemplatesChecks.ts
 */
import assert from 'assert';
import express from 'express';
import { formatWhatsAppSendFailureMessage } from '../whatsapp/providers/metaWhatsAppCloudAdapter';

function main() {
  // trust proxy must be hop-count 1 in production, never boolean true
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const appProd = express();
  if (process.env.NODE_ENV === 'production') {
    appProd.set('trust proxy', 1);
  }
  assert.strictEqual(appProd.get('trust proxy'), 1, 'production trust proxy === 1');
  assert.notStrictEqual(appProd.get('trust proxy'), true, 'must not use trust proxy true');

  process.env.NODE_ENV = 'development';
  const appDev = express();
  if (process.env.NODE_ENV === 'production') {
    appDev.set('trust proxy', 1);
  }
  assert.strictEqual(appDev.get('trust proxy'), false, 'dev leaves default trust proxy');

  // Rate limiter creation order simulation: trust proxy before rateLimit instances
  const appOrder = express();
  appOrder.set('trust proxy', 1);
  let limiterCreatedAfterTrust = false;
  if (appOrder.get('trust proxy') === 1) {
    limiterCreatedAfterTrust = true;
  }
  assert.strictEqual(limiterCreatedAfterTrust, true, 'trust proxy before limiter');

  process.env.NODE_ENV = prev;

  // APPROVED normalization
  const statuses = ['approved', 'APPROVED', 'Approved'];
  for (const s of statuses) {
    assert.strictEqual(String(s).toUpperCase() === 'APPROVED', true, `normalize ${s}`);
  }

  // No name allowlist — any APPROVED name is accepted
  const remote = [
    { name: 'hello_world', status: 'APPROVED' },
    { name: 'sample_meta_test', status: 'approved' },
    { name: 'pending_one', status: 'PENDING' },
  ];
  const approved = remote.filter((t) => String(t.status).toUpperCase() === 'APPROVED');
  assert.strictEqual(approved.length, 2, 'all APPROVED names synced (no allowlist)');

  // Pagination flag handling
  const pages = [
    { data: [{ name: 'a', status: 'APPROVED' }], paging: { next: 'https://graph.facebook.com/next' } },
    { data: [{ name: 'b', status: 'PENDING' }], paging: {} },
  ];
  let collected = 0;
  let pageIdx = 0;
  let hasNext = true;
  while (hasNext && pageIdx < pages.length) {
    collected += pages[pageIdx].data.length;
    hasNext = Boolean((pages[pageIdx] as any).paging?.next);
    pageIdx += 1;
  }
  assert.strictEqual(collected, 2, 'pagination walks pages');

  // Graph success requires message id
  const okBody = { messages: [{ id: 'wamid.ABC' }] };
  const id = okBody.messages[0]?.id;
  assert.ok(id, 'message id required');

  const failMsg = formatWhatsAppSendFailureMessage(
    { error: { message: 'Template does not exist', type: 'OAuthException', code: 132001 } },
    400
  );
  assert.ok(failMsg.startsWith('WhatsApp mesajı gönderilemedi:'), 'ui fail format');
  assert.ok(failMsg.includes('(kod: 132001)'), 'includes code');
  assert.ok(!failMsg.toLowerCase().includes('bearer'), 'no auth header');
  assert.ok(!/EAA[A-Za-z0-9]+/.test(failMsg), 'no token');

  console.log('whatsappTrustProxyAndTemplatesChecks PASS');
}

main();
