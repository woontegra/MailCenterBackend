/**
 * Self-checks for coexistence Embedded Signup ID extraction / mode flags.
 * Run: npx ts-node src/scripts/whatsappCoexistenceChecks.ts
 */
import assert from 'assert';
import { extractSignupIds } from '../services/metaEmbeddedSignupService';
import {
  isMetaTestWhatsAppPhone,
  sanitizeConnection,
  whatsappPhoneDigits,
} from '../utils/channelPlatform';

function main() {
  const standard = extractSignupIds({
    wabaId: 'W1',
    phoneNumberId: 'P1',
    businessId: 'B1',
  });
  assert.strictEqual(standard.wabaId, 'W1');
  assert.strictEqual(standard.phoneNumberId, 'P1');

  let threw = false;
  try {
    extractSignupIds({ wabaId: 'W1', phoneNumberId: null });
  } catch {
    threw = true;
  }
  assert.strictEqual(threw, true, 'standard requires phone_number_id');

  const coexistence = extractSignupIds(
    {
      raw: {
        type: 'WA_EMBEDDED_SIGNUP',
        event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
        data: { waba_id: 'WABA_ONLY' },
      },
    },
    { allowMissingPhoneNumberId: true }
  );
  assert.strictEqual(coexistence.wabaId, 'WABA_ONLY');
  assert.strictEqual(coexistence.phoneNumberId, '');

  assert.strictEqual(whatsappPhoneDigits('+90 532 317 17 55'), '905323171755');
  assert.strictEqual(isMetaTestWhatsAppPhone('+1 555-154-8955'), true);
  assert.strictEqual(isMetaTestWhatsAppPhone('+905323171755'), false);

  const sanitized = sanitizeConnection({
    id: 1,
    channel_type: 'WHATSAPP',
    encrypted_credentials: 'secret',
    settings: {
      business_phone_number: '+905323171755',
      phone_number_id: 'PNID',
      waba_id: 'WABA',
      connection_type: 'WHATSAPP_BUSINESS_APP_ONBOARDING',
    },
  }) as any;
  assert.strictEqual(sanitized.has_credentials, true);
  assert.strictEqual(sanitized.phone_number, '+905323171755');
  assert.strictEqual(sanitized.phone_number_id, 'PNID');
  assert.strictEqual(sanitized.waba_id, 'WABA');
  assert.strictEqual(sanitized.connection_type, 'WHATSAPP_BUSINESS_APP_ONBOARDING');
  assert.strictEqual(sanitized.encrypted_credentials, undefined);

  console.log('whatsappCoexistenceChecks PASS');
}

main();
