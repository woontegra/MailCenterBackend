import dotenv from 'dotenv';
import Redis from 'ioredis';

dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';

export function isMailQueueEnabled(): boolean {
  const raw = (process.env.MAIL_QUEUE_ENABLED || '').trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  // Default: enabled in production, disabled in development (safe sync fallback)
  return isProduction;
}

/**
 * Production + queue enabled requires REDIS_URL (no localhost HOST fallback).
 * Throws a safe configuration error (no secrets/URLs in the message).
 */
export function assertRedisConfigForQueue(): void {
  if (!isProduction || !isMailQueueEnabled()) return;
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) {
    throw new Error(
      'Configuration error: REDIS_URL is required when MAIL_QUEUE_ENABLED=true in production. ' +
        'Set REDIS_URL to your managed Redis connection string. Localhost fallback is disabled.'
    );
  }
}

function createRedisClient(): Redis {
  assertRedisConfigForQueue();

  const redisUrl = process.env.REDIS_URL?.trim();

  if (redisUrl) {
    if (isProduction && /localhost|127\.0\.0\.1/i.test(redisUrl)) {
      console.warn(
        '⚠ REDIS_URL points to localhost in production — this is likely a misconfiguration'
      );
    }
    return new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: false,
    });
  }

  // Development (or production with queue disabled): REDIS_HOST / PORT / PASSWORD fallback
  const host = process.env.REDIS_HOST || 'localhost';
  if (isProduction && (host === 'localhost' || host === '127.0.0.1')) {
    console.warn(
      '⚠ Redis HOST fallback to localhost in production while queue is disabled — set REDIS_URL if you enable the queue'
    );
  }

  return new Redis({
    host,
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
  });
}

export const redis = createRedisClient();

let redisReady = false;
let lastRedisError: string | null = null;

redis.on('connect', () => {
  redisReady = true;
  lastRedisError = null;
  console.log('✓ Redis connected');
});

redis.on('ready', () => {
  redisReady = true;
  lastRedisError = null;
});

redis.on('error', (error) => {
  redisReady = false;
  lastRedisError = error?.message ? String(error.message).slice(0, 200) : 'Redis error';
  console.error('✗ Redis error:', lastRedisError);
});

redis.on('close', () => {
  redisReady = false;
});

export function allowSyncSendFallback(): boolean {
  if (isProduction && isMailQueueEnabled()) return false;
  const raw = (process.env.MAIL_SYNC_FALLBACK || '').trim().toLowerCase();
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return !isProduction;
}

export async function pingRedis(): Promise<{ ok: boolean; error?: string }> {
  try {
    const pong = await redis.ping();
    const ok = pong === 'PONG';
    redisReady = ok;
    return ok ? { ok: true } : { ok: false, error: 'Unexpected PING response' };
  } catch (error: any) {
    redisReady = false;
    lastRedisError = error?.message ? String(error.message).slice(0, 200) : 'ping_failed';
    return { ok: false, error: lastRedisError };
  }
}

export function getRedisStatusSnapshot() {
  return {
    ready: redisReady,
    lastError: lastRedisError,
    queueEnabled: isMailQueueEnabled(),
    syncFallbackAllowed: allowSyncSendFallback(),
    usingUrl: Boolean(process.env.REDIS_URL?.trim()),
  };
}

export default redis;
