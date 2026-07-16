/**
 * Outbound queue unit checks without live SMTP delivery.
 */
const {
  sanitizeOutboundErrorMessage,
  classifySendError,
} = require('../dist/config/outboundQueue.js');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(
  !sanitizeOutboundErrorMessage('pass=secret enc:v1:abcdef host=smtp').includes('secret'),
  'password redacted'
);
assert(
  !sanitizeOutboundErrorMessage('Bearer tokencredit').includes('tokencredit') ||
    sanitizeOutboundErrorMessage('Bearer abcdefghijklmnop').includes('[redacted]'),
  'bearer redacted'
);

const transient = classifySendError({ code: 'ETIMEDOUT', message: 'connection timeout' });
assert(transient.retryable === true, 'timeout retryable');

const permanent = classifySendError({ message: '550 mailbox unavailable' });
assert(permanent.retryable === false, '550 not retryable');

const authFail = classifySendError({ message: 'Invalid login' });
assert(authFail.retryable === false, 'auth not retryable');

console.log('✓ outbound queue classification verification passed');
