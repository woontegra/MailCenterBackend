/**
 * Eligibility rule checks without DB (mock-free unit logic mirrored).
 * Run: npx ts-node src/scripts/eligibilityLogicChecks.ts
 */
import { normalizeEmail } from '../utils/contactNormalize';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// Mirror of EMAIL compose policy: only BLOCKED blocks; OPTED_OUT does not.
function emailComposeEligible(preference: string | null, contactStatus: string | null) {
  if (contactStatus === 'BLOCKED') return { eligible: false, code: 'CONTACT_BLOCKED' };
  if (preference === 'BLOCKED') return { eligible: false, code: 'BLOCKED' };
  return { eligible: true };
}

function smsEligible(preference: string | null) {
  if (preference === 'BLOCKED' || preference === 'OPTED_OUT') {
    return { eligible: false, code: preference };
  }
  if (!preference || preference === 'UNKNOWN') {
    return { eligible: false, code: 'UNKNOWN_PREFERENCE' };
  }
  if (preference !== 'OPTED_IN') return { eligible: false, code: 'NOT_OPTED_IN' };
  return { eligible: true };
}

assert(emailComposeEligible('OPTED_OUT', 'ACTIVE').eligible, 'EMAIL OPTED_OUT still sendable');
assert(!emailComposeEligible('BLOCKED', 'ACTIVE').eligible, 'EMAIL BLOCKED blocked');
assert(!emailComposeEligible('UNKNOWN', 'BLOCKED').eligible, 'contact BLOCKED blocked');
assert(!smsEligible('UNKNOWN').eligible, 'SMS UNKNOWN not eligible');
assert(!smsEligible('OPTED_OUT').eligible, 'SMS OPTED_OUT not eligible');
assert(smsEligible('OPTED_IN').eligible, 'SMS OPTED_IN eligible');

const a = normalizeEmail('A@B.COM');
const b = normalizeEmail('a@b.com');
assert(a.ok && b.ok && a.normalized === b.normalized, 'same normalized email');

console.log('✓ eligibilityLogicChecks passed');
