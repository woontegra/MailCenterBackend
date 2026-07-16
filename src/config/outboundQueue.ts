export const outboundQueueConfig = {
  maxAttempts: Math.max(1, parseInt(process.env.OUTBOUND_MAX_ATTEMPTS || '5', 10) || 5),
  tenantPerMinute: Math.max(
    1,
    parseInt(process.env.OUTBOUND_TENANT_PER_MINUTE || '30', 10) || 30
  ),
  senderPerMinute: Math.max(
    1,
    parseInt(process.env.OUTBOUND_SENDER_PER_MINUTE || '10', 10) || 10
  ),
  recipientPerMinute: Math.max(
    1,
    parseInt(process.env.OUTBOUND_RECIPIENT_PER_MINUTE || '3', 10) || 3
  ),
  rateLimitDelayMs: Math.max(
    1000,
    parseInt(process.env.OUTBOUND_RATE_LIMIT_DELAY_MS || '60000', 10) || 60000
  ),
  backoffBaseMs: Math.max(
    1000,
    parseInt(process.env.OUTBOUND_BACKOFF_BASE_MS || '5000', 10) || 5000
  ),
};

export function sanitizeOutboundErrorMessage(input: unknown, max = 400): string {
  const raw = String(input || 'Gönderim başarısız')
    .replace(/enc:v1:[^\s]+/gi, '[redacted]')
    .replace(/pass(word)?[=:]\s*\S+/gi, 'password=[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[\u0000-\u001F]/g, ' ')
    .trim();
  return raw.slice(0, max) || 'Gönderim başarısız';
}

export function classifySendError(error: unknown): {
  code: string;
  retryable: boolean;
  message: string;
} {
  const message = sanitizeOutboundErrorMessage(
    (error as any)?.message || (error as any)?.response || error
  );
  const code = String((error as any)?.code || (error as any)?.responseCode || 'SEND_FAILED');
  const lower = message.toLowerCase();

  const permanentHints = [
    'invalid login',
    'authentication failed',
    'mailbox unavailable',
    'user unknown',
    'recipient rejected',
    'relay access denied',
    'sender identity',
    'not eligible',
    'inactive',
    'header',
    'invalid email',
    '550 ',
    '551 ',
    '552 ',
    '553 ',
    '554 ',
  ];

  const transientHints = [
    'timeout',
    'etimedout',
    'econnreset',
    'econnrefused',
    'enotfound',
    'temporar',
    'try again',
    'rate',
    '421 ',
    '450 ',
    '451 ',
    '452 ',
    '4. ',
  ];

  if (permanentHints.some((h) => lower.includes(h) || code.toLowerCase().includes(h.trim()))) {
    return { code: code.slice(0, 100), retryable: false, message };
  }

  if (
    transientHints.some((h) => lower.includes(h)) ||
    ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ESOCKET'].includes(code)
  ) {
    return { code: code.slice(0, 100), retryable: true, message };
  }

  // Default: retry a few times for unknown transport issues
  return { code: code.slice(0, 100), retryable: true, message };
}
