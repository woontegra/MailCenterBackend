import Redis from 'ioredis';
import redis from '../config/redis';
import { getImapAccountLockTtlSeconds } from '../config/imapIdleConfig';

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("expire", KEYS[1], ARGV[2])
else
  return 0
end
`;

export function imapAccountLockKey(tenantId: number, accountId: number): string {
  return `mailcenter:imap:lock:${tenantId}:${accountId}`;
}

export class ImapAccountLock {
  private readonly key: string;
  private readonly token: string;
  private heartbeat: NodeJS.Timeout | null = null;
  private held = false;

  constructor(
    private readonly tenantId: number,
    private readonly accountId: number,
    private readonly client: Redis = redis,
    private readonly ttlSeconds: number = getImapAccountLockTtlSeconds()
  ) {
    this.key = imapAccountLockKey(tenantId, accountId);
    this.token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  }

  async tryAcquire(): Promise<boolean> {
    const result = await this.client.set(this.key, this.token, 'EX', this.ttlSeconds, 'NX');
    this.held = result === 'OK';
    if (this.held) {
      this.startHeartbeat();
    }
    return this.held;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const intervalMs = Math.max(5000, Math.floor((this.ttlSeconds * 1000) / 3));
    this.heartbeat = setInterval(() => {
      void this.renew().catch(() => {
        this.held = false;
        this.stopHeartbeat();
      });
    }, intervalMs);
    if (typeof this.heartbeat.unref === 'function') {
      this.heartbeat.unref();
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  async renew(): Promise<boolean> {
    if (!this.held) return false;
    const ok = await this.client.eval(RENEW_SCRIPT, 1, this.key, this.token, String(this.ttlSeconds));
    this.held = Number(ok) === 1;
    return this.held;
  }

  async release(): Promise<void> {
    this.stopHeartbeat();
    if (!this.held) return;
    try {
      await this.client.eval(RELEASE_SCRIPT, 1, this.key, this.token);
    } catch {
      /* ignore release errors on shutdown */
    }
    this.held = false;
  }

  isHeld(): boolean {
    return this.held;
  }
}
