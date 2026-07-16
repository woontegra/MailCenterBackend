/**
 * Mock Meta WhatsApp Cloud API checks (no real messages).
 * Run: npx ts-node src/scripts/whatsappModuleChecks.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import * as crypto from 'crypto';
import { MetaWhatsAppCloudAdapter } from '../whatsapp/providers/metaWhatsAppCloudAdapter';
import {
  packWhatsAppCredentials,
  unpackWhatsAppCredentials,
} from '../whatsapp/whatsappCredentials';
import { canAdvanceOutboundStatus } from '../whatsapp/whatsappConversationWindow';
import { assertMailCredentialsEncryptionConfigured } from '../utils/mailCredentialsCrypto';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

async function main() {
  if (!process.env.MAIL_CREDENTIALS_ENCRYPTION_KEY) {
    process.env.MAIL_CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  }
  assertMailCredentialsEncryptionConfigured();

  const packed = packWhatsAppCredentials({
    access_token: 'EAA_test_token_secret',
    app_secret: 'app_secret_value',
    webhook_verify_token: 'verify-me',
  });
  assert(packed.startsWith('enc:v1:'), 'encrypted');
  assert(!packed.includes('EAA_test_token_secret'), 'token not plaintext in cipher blob');
  const unpacked = unpackWhatsAppCredentials(packed);
  assert(unpacked.accessToken === 'EAA_test_token_secret', 'token roundtrip');

  const okFetch: typeof fetch = async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes('/messages') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body || '{}'));
      assert(body.messaging_product === 'whatsapp', 'messaging_product');
      assert(!JSON.stringify(body).includes('EAA_'), 'token not in body');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          messages: [{ id: 'wamid.TEST123' }],
        }),
      } as any;
    }
    // GET phone number test
    return {
      ok: true,
      status: 200,
      json: async () => ({
        display_phone_number: '+15550001111',
        verified_name: 'Test Biz',
      }),
    } as any;
  };

  const adapter = new MetaWhatsAppCloudAdapter(okFetch);
  const test = await adapter.testConnection(
    { accessToken: 'tok', appSecret: 'sec', webhookVerifyToken: 'v' },
    {
      wabaId: '1',
      phoneNumberId: '99',
      apiVersion: 'v23.0',
    }
  );
  assert(test.ok && test.displayPhoneNumber === '+15550001111', 'testConnection');

  const sent = await adapter.sendTemplateMessage(
    { accessToken: 'tok', appSecret: 'sec', webhookVerifyToken: 'v' },
    {
      toE164: '+905321112233',
      toProviderNumber: '905321112233',
      phoneNumberId: '99',
      apiVersion: 'v23.0',
      templateName: 'hello_world',
      languageCode: 'en_US',
    }
  );
  assert(sent.success && sent.providerMessageId === 'wamid.TEST123', 'template send');

  const failAdapter = new MetaWhatsAppCloudAdapter(async () =>
    ({
      ok: false,
      status: 400,
      json: async () => ({
        error: { code: 132001, message: 'Template name does not exist in the translation' },
      }),
    }) as any
  );
  try {
    await failAdapter.sendTemplateMessage(
      { accessToken: 'tok', appSecret: 'sec', webhookVerifyToken: 'v' },
      {
        toE164: '+905321112233',
        toProviderNumber: '905321112233',
        phoneNumberId: '99',
        apiVersion: 'v23.0',
        templateName: 'missing',
        languageCode: 'en_US',
      }
    );
    throw new Error('should fail');
  } catch (e: any) {
    const c = failAdapter.classifyError(e);
    assert(c.retryable === false, 'template missing permanent');
    assert(!JSON.stringify(c).includes('tok'), 'no token in error');
  }

  // Webhook verify
  const verify = adapter.verifyWebhook({
    mode: 'subscribe',
    challenge: '12345',
    verifyToken: 'verify-me',
    expectedVerifyToken: 'verify-me',
  });
  assert(verify.ok && verify.challenge === '12345', 'webhook verify');

  // Signature
  const raw = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }));
  const sig =
    'sha256=' +
    crypto.createHmac('sha256', 'app_secret_value').update(raw).digest('hex');
  assert(
    adapter.validateWebhookSignature({
      appSecret: 'app_secret_value',
      rawBody: raw,
      signatureHeader: sig,
    }),
    'valid signature'
  );
  assert(
    !adapter.validateWebhookSignature({
      appSecret: 'app_secret_value',
      rawBody: raw,
      signatureHeader: 'sha256=deadbeef',
    }),
    'invalid signature rejected'
  );

  // Parse status + inbound
  const events = adapter.parseWebhook({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: '99' },
              statuses: [
                { id: 'wamid.1', status: 'delivered', recipient_id: '9053' },
                { id: 'wamid.1', status: 'read', recipient_id: '9053' },
              ],
              contacts: [{ profile: { name: 'Ali' }, wa_id: '9053' }],
              messages: [
                {
                  from: '905321112233',
                  id: 'wamid.in1',
                  timestamp: '1749416383',
                  type: 'text',
                  text: { body: 'Merhaba' },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  assert(events.some((e) => e.kind === 'status' && e.status === 'read'), 'status parsed');
  assert(events.some((e) => e.kind === 'inbound' && e.textBody === 'Merhaba'), 'inbound parsed');

  assert(canAdvanceOutboundStatus('SENT', 'DELIVERED'), 'sent→delivered');
  assert(canAdvanceOutboundStatus('DELIVERED', 'READ'), 'delivered→read');
  assert(!canAdvanceOutboundStatus('READ', 'DELIVERED'), 'no backward');
  assert(!canAdvanceOutboundStatus('READ', 'SENT'), 'no backward to sent');

  console.log('✓ whatsappModuleChecks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
