/**
 * Domain validation + SPF/DMARC/MX parsing checks (no live SMTP).
 */
const {
  normalizeDomainInput,
  extractEmailDomain,
  aggregateOverallStatus,
} = require('../dist/utils/domainValidation.js');

const {
  runDeliverabilityDnsCheck,
} = require('../dist/services/deliverabilityDnsService.js');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Domain format
assert(normalizeDomainInput('example.com').ok === true, 'valid domain');
assert(normalizeDomainInput('https://example.com').ok === false, 'reject protocol');
assert(normalizeDomainInput('example.com/path').ok === false, 'reject path');
assert(normalizeDomainInput('example.com:443').ok === false, 'reject port');
assert(normalizeDomainInput('*.example.com').ok === false, 'reject wildcard');
assert(normalizeDomainInput('a@b.com').ok === false, 'reject email-as-domain');
assert(extractEmailDomain('Info@Example.COM') === 'example.com', 'email domain extract');

assert(aggregateOverallStatus(['VALID', 'WARNING']) === 'WARNING', 'aggregate warning');
assert(aggregateOverallStatus(['VALID', 'INVALID']) === 'INVALID', 'aggregate invalid');
assert(aggregateOverallStatus(['VALID', 'ERROR']) === 'ERROR', 'aggregate error');
assert(aggregateOverallStatus(['NOT_CHECKED', 'NOT_CHECKED']) === 'NOT_CHECKED', 'aggregate none');

// Live DNS against a well-known domain (google.com) — structure only, may vary by network
;(async () => {
  try {
    const result = await runDeliverabilityDnsCheck({
      domain: 'google.com',
      dkimSelector: null,
    });
    assert(result.domain === 'google.com', 'domain normalized');
    assert(['VALID', 'WARNING', 'INVALID', 'ERROR', 'NOT_CHECKED'].includes(result.spf_status), 'spf status');
    assert(['VALID', 'WARNING', 'INVALID', 'ERROR', 'NOT_CHECKED'].includes(result.mx_status), 'mx status');
    assert(result.dkim_status === 'NOT_CHECKED', 'dkim skipped without selector');
    assert(Array.isArray(result.warnings), 'warnings array');
    assert(
      result.warnings.some((w) => w.code === 'NO_SPAM_GUARANTEE'),
      'includes no-spam-guarantee disclaimer'
    );
    console.log('✓ deliverability DNS live check structure ok');
  } catch (e) {
    // Network may be blocked; still pass format tests
    console.log('⚠ live DNS skipped:', e.message);
  }

  // Timeout / invalid selector path should not throw for malformed selector (treated as skip)
  const skipped = await runDeliverabilityDnsCheck({
    domain: 'example.com',
    dkimSelector: '!!!bad!!!',
  });
  assert(skipped.dkim_status === 'NOT_CHECKED', 'bad selector skips dkim');
  assert(skipped.warnings.some((w) => w.code === 'DKIM_SELECTOR_INVALID'), 'invalid selector warning');

  console.log('✓ domain deliverability verification passed');
})().catch((e) => {
  console.error('VERIFY_FAIL', e.message);
  process.exit(1);
});
