/**
 * Mock Netgsm HTTP + segment + credential sanitize checks (no real SMS).
 * Run: npx ts-node src/scripts/smsModuleChecks.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import { NetgsmAdapter } from '../sms/providers/netgsmAdapter';
import { analyzeSmsContent, assertSmsLengthAllowed } from '../sms/smsSegmentCounter';
import { packSmsCredentials, unpackSmsCredentials } from '../sms/smsCredentials';
import { sanitizeSmsPlainText, containsHtml } from '../sms/smsContent';
import { assertMailCredentialsEncryptionConfigured } from '../utils/mailCredentialsCrypto';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

async function main() {
  if (!process.env.MAIL_CREDENTIALS_ENCRYPTION_KEY) {
    // Deterministic 32-byte key for local check only
    process.env.MAIL_CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  }
  assertMailCredentialsEncryptionConfigured();

  const gsm = analyzeSmsContent('Merhaba dunya 123');
  assert(gsm.encoding === 'GSM-7', 'ASCII/GSM expected');
  assert(gsm.segmentCount === 1, 'single segment');

  const uni = analyzeSmsContent('Merhaba dünya ğüşı');
  assert(uni.encoding === 'Unicode', 'Turkish chars → Unicode');

  const longGsm = 'A'.repeat(161);
  const longInfo = analyzeSmsContent(longGsm);
  assert(longInfo.segmentCount === 2, 'concat GSM');

  assert(assertSmsLengthAllowed('').ok === false, 'empty rejected');
  assert(containsHtml('<b>x</b>'), 'html detected');
  assert(sanitizeSmsPlainText('<b>Hi</b>\u0000') === 'Hi', 'sanitize');

  const packed = packSmsCredentials({
    username: 'demo_user',
    password: 'super-secret-pass',
    appname: 'mailcenter',
  });
  assert(packed.startsWith('enc:v1:'), 'encrypted');
  assert(!packed.includes('super-secret-pass'), 'secret not in ciphertext string visibly as plaintext');
  const unpacked = unpackSmsCredentials(packed);
  assert(unpacked.username === 'demo_user', 'username roundtrip');
  assert(unpacked.password === 'super-secret-pass', 'password roundtrip');

  // Mock success send
  const okFetch: typeof fetch = async (input: any) => {
    const url = String(input);
    if (url.includes('/msgheader')) {
      return {
        status: 200,
        json: async () => ({ code: '00', msgheader: ['TESTHDR', 'WOONTEGRA'] }),
      } as any;
    }
    if (url.includes('/send')) {
      return {
        status: 200,
        json: async () => ({ code: '00', jobid: '999888777' }),
      } as any;
    }
    throw new Error('unexpected url ' + url);
  };

  const adapter = new NetgsmAdapter(okFetch);
  const test = await adapter.testConnection({ username: 'u', password: 'p' });
  assert(test.ok && test.headers?.includes('TESTHDR'), 'mock testConnection');

  const sent = await adapter.sendMessage(
    { username: 'u', password: 'p' },
    {
      toE164: '+905321112233',
      toProviderNumber: '905321112233',
      message: 'Merhaba',
      senderHeader: 'TESTHDR',
      iysfilter: '0',
    }
  );
  assert(sent.success && sent.providerMessageId === '999888777', 'mock send success');

  // Mock auth failure
  const failFetch: typeof fetch = async () =>
    ({
      status: 406,
      json: async () => ({ code: '30', description: 'auth' }),
    }) as any;
  const failAdapter = new NetgsmAdapter(failFetch);
  const failTest = await failAdapter.testConnection({ username: 'u', password: 'bad' });
  assert(!failTest.ok && failTest.code === '30', 'mock auth fail');

  try {
    await failAdapter.sendMessage(
      { username: 'u', password: 'bad' },
      {
        toE164: '+905321112233',
        toProviderNumber: '905321112233',
        message: 'x',
        senderHeader: 'TESTHDR',
      }
    );
    throw new Error('should have thrown');
  } catch (e: any) {
    const classified = failAdapter.classifyError(e);
    assert(classified.code === '30' && classified.retryable === false, 'permanent auth');
    assert(!JSON.stringify(classified).includes('bad'), 'no secret in classification');
  }

  // Rate limit retryable
  const rateClass = adapter.classifyError({ code: '80' });
  assert(rateClass.retryable === true, 'rate limit retryable');
  const headerClass = adapter.classifyError({ code: '40' });
  assert(headerClass.retryable === false, 'invalid header permanent');

  console.log('✓ smsModuleChecks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
