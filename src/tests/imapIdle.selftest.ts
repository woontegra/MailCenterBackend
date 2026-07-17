/**
 * Lightweight self-checks for IMAP IDLE helpers (no live provider / Redis required).
 * Run: npx ts-node src/tests/imapIdle.selftest.ts
 */
import assert from 'assert';
import {
  computeReconnectDelayMs,
  isImapIdleEnabled,
} from '../config/imapIdleConfig';
import { isImapAuthError, mapImapMessage, safeImapErrorMessage } from '../services/imapService';

function imapAccountLockKey(tenantId: number, accountId: number): string {
  return `mailcenter:imap:lock:${tenantId}:${accountId}`;
}

function testReconnectBackoff() {
  const d1 = computeReconnectDelayMs(1, 300);
  const d3 = computeReconnectDelayMs(3, 300);
  const d10 = computeReconnectDelayMs(10, 60);
  assert.ok(d1 >= 5000, 'first delay >= 5s');
  assert.ok(d3 > d1, 'delay grows');
  assert.ok(d10 <= 60_000, 'respects max delay');
  console.log('✓ reconnect backoff');
}

function testAuthErrorDetection() {
  assert.strictEqual(isImapAuthError({ authenticationFailed: true }), true);
  assert.strictEqual(isImapAuthError({ message: 'Authentication failed' }), true);
  assert.strictEqual(isImapAuthError({ message: 'ETIMEDOUT' }), false);
  const safe = safeImapErrorMessage({ message: 'password=secret-value failed' });
  assert.ok(!safe.includes('secret-value'), 'secrets redacted');
  console.log('✓ auth error + redaction');
}

function testMessageIdStable() {
  const mapped = mapImapMessage(
    {
      uid: 42,
      envelope: {
        subject: 'Test',
        from: [{ address: 'a@b.com' }],
        to: [{ address: 'c@d.com' }],
        date: new Date('2026-01-01'),
      },
    } as any,
    7
  );
  assert.ok(mapped);
  assert.strictEqual(mapped!.uid, 42);
  assert.strictEqual(mapped!.messageId, '<imap-7-42@mailcenter.local>');
  const again = mapImapMessage(
    {
      uid: 42,
      envelope: {
        subject: 'Test',
        from: [{ address: 'a@b.com' }],
        to: [{ address: 'c@d.com' }],
        date: new Date('2026-01-01'),
      },
    } as any,
    7
  );
  assert.strictEqual(mapped!.messageId, again!.messageId, 'stable without Date.now()');
  console.log('✓ stable Message-ID fallback');
}

function testLockKeyTenantScoped() {
  assert.strictEqual(imapAccountLockKey(1, 9), 'mailcenter:imap:lock:1:9');
  assert.notStrictEqual(imapAccountLockKey(1, 9), imapAccountLockKey(2, 9));
  console.log('✓ lock key tenant scoped');
}

function testIdleFlagParses() {
  const prev = process.env.IMAP_IDLE_ENABLED;
  process.env.IMAP_IDLE_ENABLED = 'true';
  assert.strictEqual(isImapIdleEnabled(), true);
  process.env.IMAP_IDLE_ENABLED = 'false';
  assert.strictEqual(isImapIdleEnabled(), false);
  if (prev === undefined) delete process.env.IMAP_IDLE_ENABLED;
  else process.env.IMAP_IDLE_ENABLED = prev;
  console.log('✓ IMAP_IDLE_ENABLED parsing');
}

function main() {
  testReconnectBackoff();
  testAuthErrorDetection();
  testMessageIdStable();
  testLockKeyTenantScoped();
  testIdleFlagParses();
  console.log('\nAll IMAP IDLE self-tests passed.');
}

main();
