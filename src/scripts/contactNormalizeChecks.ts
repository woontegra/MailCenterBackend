/**
 * Lightweight checks for contact normalize + eligibility rules (no DB).
 * Run: npx ts-node src/scripts/contactNormalizeChecks.ts
 */
import { normalizeEmail, normalizePhone } from '../utils/contactNormalize';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const email1 = normalizeEmail('  Foo.Bar@Example.COM ');
assert(email1.ok && email1.normalized === 'foo.bar@example.com', 'email lowercases');

const emailBad = normalizeEmail('not-an-email');
assert(!emailBad.ok, 'invalid email rejected');

const phonePlus = normalizePhone({ value: '+90 532 111 22 33' });
assert(phonePlus.ok && phonePlus.normalized === '+905321112233', 'E.164 phone');

const phoneNoCc = normalizePhone({ value: '05321112233', countryCode: null });
assert(!phoneNoCc.ok, 'no invented country code');

const phoneWithCc = normalizePhone({ value: '05321112233', countryCode: '90' });
assert(phoneWithCc.ok && phoneWithCc.normalized === '+905321112233', 'national + tenant cc');

const phoneBad = normalizePhone({ value: '123', countryCode: '90' });
assert(!phoneBad.ok, 'short phone rejected');

console.log('✓ contactNormalizeChecks passed');
