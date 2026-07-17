/**
 * Lightweight self-checks for IMAP IDLE helpers (no live provider / Redis required).
 * Run: npx ts-node src/tests/imapIdle.selftest.ts
 */
import assert from 'assert';
import { EventEmitter } from 'events';
import {
  computeReconnectDelayMs,
  getImapIdleTimingMs,
  isImapIdleEnabled,
} from '../config/imapIdleConfig';
import { ConnectionLostGuard } from '../utils/connectionLostGuard';
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

function testIdleTimingConfig() {
  const prevMax = process.env.IMAP_MAX_IDLE_TIME_SECONDS;
  const prevSocket = process.env.IMAP_SOCKET_TIMEOUT_SECONDS;
  delete process.env.IMAP_MAX_IDLE_TIME_SECONDS;
  delete process.env.IMAP_SOCKET_TIMEOUT_SECONDS;
  const defaults = getImapIdleTimingMs();
  assert.ok(defaults.maxIdleTime < defaults.socketTimeout, 'default maxIdleTime < socketTimeout');
  assert.strictEqual(defaults.maxIdleTime, 240_000);
  assert.strictEqual(defaults.socketTimeout, 900_000);

  process.env.IMAP_MAX_IDLE_TIME_SECONDS = '600';
  process.env.IMAP_SOCKET_TIMEOUT_SECONDS = '300';
  const corrected = getImapIdleTimingMs();
  assert.strictEqual(corrected.maxIdleTime, 240_000);
  assert.strictEqual(corrected.socketTimeout, 900_000);

  if (prevMax === undefined) delete process.env.IMAP_MAX_IDLE_TIME_SECONDS;
  else process.env.IMAP_MAX_IDLE_TIME_SECONDS = prevMax;
  if (prevSocket === undefined) delete process.env.IMAP_SOCKET_TIMEOUT_SECONDS;
  else process.env.IMAP_SOCKET_TIMEOUT_SECONDS = prevSocket;
  console.log('✓ IMAP idle timing config');
}

function testConnectionLostGuard() {
  const guard = new ConnectionLostGuard();
  assert.strictEqual(guard.tryHandle(), true);
  assert.strictEqual(guard.tryHandle(), false, 'second error/close must be ignored');
  guard.reset();
  assert.strictEqual(guard.tryHandle(), true);
  console.log('✓ connection lost guard');
}

function testErrorListenerPreventsUnhandledCrash() {
  const emitter = new EventEmitter();
  let handled = 0;
  emitter.on('error', () => {
    handled += 1;
  });
  emitter.emit('error', Object.assign(new Error('Socket timeout'), { code: 'ETIMEDOUT' }));
  assert.strictEqual(handled, 1);
  console.log('✓ error listener prevents unhandled ETIMEDOUT');
}

function main() {
  testReconnectBackoff();
  testAuthErrorDetection();
  testMessageIdStable();
  testLockKeyTenantScoped();
  testIdleFlagParses();
  testIdleTimingConfig();
  testConnectionLostGuard();
  testErrorListenerPreventsUnhandledCrash();
  console.log('\nAll IMAP IDLE self-tests passed.');
}

main();
