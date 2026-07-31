/**
 * Self-checks for coexistence Embedded Signup ID extraction / mode flags.
 * Run: npx ts-node src/scripts/whatsappCoexistenceChecks.ts
 */
import assert from 'assert';
import { extractSignupIds } from '../services/metaEmbeddedSignupService';

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

  console.log('whatsappCoexistenceChecks PASS');
}

main();
