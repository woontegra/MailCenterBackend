const isProduction = process.env.NODE_ENV === 'production';

function isMailQueueEnabledLocal(): boolean {
  const raw = (process.env.MAIL_QUEUE_ENABLED || '').trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return isProduction;
}

export function isImapIdleEnabled(): boolean {
  const raw = (process.env.IMAP_IDLE_ENABLED || '').trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return isProduction;
}

export function getImapReconcileIntervalMinutes(): number {
  const n = parseInt(process.env.IMAP_RECONCILE_INTERVAL_MINUTES || '15', 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 180) : 15;
}

export function getImapReconnectMaxDelaySeconds(): number {
  const n = parseInt(process.env.IMAP_RECONNECT_MAX_DELAY_SECONDS || '300', 10);
  return Number.isFinite(n) && n >= 10 ? Math.min(n, 3600) : 300;
}

export function getImapAccountLockTtlSeconds(): number {
  const n = parseInt(process.env.IMAP_ACCOUNT_LOCK_TTL_SECONDS || '45', 10);
  return Number.isFinite(n) && n >= 15 ? Math.min(n, 300) : 45;
}

export function getImapAccountWatchIntervalSeconds(): number {
  const n = parseInt(process.env.IMAP_ACCOUNT_WATCH_INTERVAL_SECONDS || '45', 10);
  return Number.isFinite(n) && n >= 15 ? Math.min(n, 300) : 45;
}

const DEFAULT_MAX_IDLE_SECONDS = 240;
const DEFAULT_SOCKET_TIMEOUT_SECONDS = 900;

/**
 * ImapFlow keepalive timings (milliseconds).
 * maxIdleTime must stay below socketTimeout so IDLE refreshes before socket inactivity timeout.
 */
export function getImapIdleTimingMs(): { maxIdleTime: number; socketTimeout: number } {
  const rawMaxIdle = parseInt(process.env.IMAP_MAX_IDLE_TIME_SECONDS || '', 10);
  const rawSocket = parseInt(process.env.IMAP_SOCKET_TIMEOUT_SECONDS || '', 10);

  let maxIdleSeconds =
    Number.isFinite(rawMaxIdle) && rawMaxIdle >= 30 ? Math.min(rawMaxIdle, 3600) : DEFAULT_MAX_IDLE_SECONDS;
  let socketSeconds =
    Number.isFinite(rawSocket) && rawSocket >= 60 ? Math.min(rawSocket, 7200) : DEFAULT_SOCKET_TIMEOUT_SECONDS;

  if (maxIdleSeconds >= socketSeconds) {
    console.warn(
      'IMAP_MAX_IDLE_TIME_SECONDS must be less than IMAP_SOCKET_TIMEOUT_SECONDS; using safe defaults (240/900)'
    );
    maxIdleSeconds = DEFAULT_MAX_IDLE_SECONDS;
    socketSeconds = DEFAULT_SOCKET_TIMEOUT_SECONDS;
  }

  return {
    maxIdleTime: maxIdleSeconds * 1000,
    socketTimeout: socketSeconds * 1000,
  };
}

/**
 * Production + IDLE requires Redis. Throws a safe configuration error (no secrets).
 */
export function assertImapIdleConfig(): void {
  if (!isImapIdleEnabled()) return;

  const redisUrl = process.env.REDIS_URL?.trim();
  if (isProduction && !redisUrl) {
    throw new Error(
      'Configuration error: REDIS_URL is required when IMAP_IDLE_ENABLED=true in production. ' +
        'Real-time IMAP listeners use Redis distributed locks and cannot start without Redis.'
    );
  }

  if (isProduction && isMailQueueEnabledLocal() && !redisUrl) {
    throw new Error(
      'Configuration error: REDIS_URL is required when MAIL_QUEUE_ENABLED=true in production. ' +
        'Set REDIS_URL to your managed Redis connection string. Localhost fallback is disabled.'
    );
  }
}

export function computeReconnectDelayMs(attempt: number, maxDelaySeconds: number): number {
  const base = 5000;
  const exp = Math.min(maxDelaySeconds * 1000, base * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = Math.floor(Math.random() * Math.min(1000, exp * 0.2));
  return Math.min(maxDelaySeconds * 1000, exp + jitter);
}
