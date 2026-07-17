import { ImapFlow } from 'imapflow';
import Redis from 'ioredis';
import { query } from '../config/database';
import {
  computeReconnectDelayMs,
  getImapAccountWatchIntervalSeconds,
  getImapReconcileIntervalMinutes,
  getImapReconnectMaxDelaySeconds,
  isImapIdleEnabled,
} from '../config/imapIdleConfig';
import { MailAccount } from '../types';
import {
  createImapClient,
  fetchMessagesByUidRange,
  isImapAuthError,
  isInboxOpen,
  openInbox,
  readMailboxMeta,
  safeImapErrorMessage,
} from './imapService';
import { idleDiag } from '../utils/imapDiag';
import { connectionFingerprint, shouldFetchOnExists } from '../utils/imapIdleHelpers';
import { MailFetchService } from './mailFetchService';
import { ImapAccountLock } from './redisAccountLock';
import {
  MailAccountEvent,
  subscribeMailAccountEvents,
} from './redisEventBus';
import { withDecryptedCredentials } from '../utils/mailAccountUtils';
import { ConnectionLostGuard } from '../utils/connectionLostGuard';

export type IdleConnectionState =
  | 'CONNECTING'
  | 'IDLE'
  | 'RECONNECTING'
  | 'ERROR'
  | 'DISABLED';

class AccountIdleListener {
  private state: IdleConnectionState = 'DISABLED';
  private client: ImapFlow | null = null;
  private lock: ImapAccountLock | null = null;
  private stopRequested = false;
  private intentionalClose = false;
  private runPromise: Promise<void> | null = null;
  private fetchChain: Promise<void> = Promise.resolve();
  private accountSnapshot: MailAccount;
  private reconnectAttempt = 0;
  private authFailedPermanently = false;
  private connectionLost = false;
  private connectionLostError: unknown = null;
  private readonly connectionLostGuard = new ConnectionLostGuard();
  private clientEventHandlers: {
    error: (err: Error) => void;
    close: () => void;
  } | null = null;
  private existsHandler:
    | ((data?: { path?: string; count?: number; prevCount?: number }) => void)
    | null = null;
  private readonly fetchService = new MailFetchService();
  private readonly maxDelaySeconds = getImapReconnectMaxDelaySeconds();
  private readonly reconcileEveryMs = getImapReconcileIntervalMinutes() * 60 * 1000;
  private lastReconcileAt = 0;
  private connFingerprint: string;

  constructor(account: MailAccount) {
    this.accountSnapshot = account;
    this.connFingerprint = connectionFingerprint(account);
  }

  getState(): IdleConnectionState {
    return this.state;
  }

  getConnectionFingerprint(): string {
    return this.connFingerprint;
  }

  updateAccount(account: MailAccount): void {
    this.accountSnapshot = account;
    this.connFingerprint = connectionFingerprint(account);
  }

  start(): void {
    if (this.runPromise) return;
    this.stopRequested = false;
    this.authFailedPermanently = false;
    this.runPromise = this.loop().finally(() => {
      this.runPromise = null;
    });
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.intentionalClose = true;
    await this.teardownClient();
    if (this.lock) {
      await this.lock.release();
      this.lock = null;
    }
    await this.setDbStatus('DISABLED', null, false);
    if (this.runPromise) {
      await this.runPromise.catch(() => undefined);
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopRequested) {
      if (this.authFailedPermanently) {
        await this.setDbStatus('ERROR', 'IMAP kimlik doğrulama başarısız', false);
        return;
      }

      this.lock = new ImapAccountLock(
        this.accountSnapshot.tenant_id!,
        this.accountSnapshot.id
      );
      const acquired = await this.lock.tryAcquire();
      if (!acquired) {
        await this.setDbStatus('DISABLED', null, false);
        await sleep(8000 + Math.floor(Math.random() * 4000));
        continue;
      }

      try {
        await this.connectIdleAndServe();
        this.reconnectAttempt = 0;
      } catch (error: unknown) {
        const safe = safeImapErrorMessage(error);
        if (isImapAuthError(error)) {
          this.authFailedPermanently = true;
          await this.setDbStatus('ERROR', safe, false);
          console.error(`IMAP auth error for account #${this.accountSnapshot.id}:`, safe);
          return;
        }

        this.reconnectAttempt += 1;
        const delay = computeReconnectDelayMs(this.reconnectAttempt, this.maxDelaySeconds);
        if (this.state !== 'RECONNECTING') {
          await this.setDbStatus('RECONNECTING', safe, false);
        }
        console.error(
          `IMAP reconnect scheduled for account #${this.accountSnapshot.id} in ${delay}ms:`,
          safe
        );
        await this.teardownClient();
        await sleep(delay);
      } finally {
        if (this.lock) {
          await this.lock.release();
          this.lock = null;
        }
      }
    }

    await this.setDbStatus('DISABLED', null, false);
  }

  private async connectIdleAndServe(): Promise<void> {
    await this.setDbStatus('CONNECTING', null, true);

    this.connectionLost = false;
    this.connectionLostError = null;
    this.connectionLostGuard.reset();
    this.intentionalClose = false;

    const accountId = this.accountSnapshot.id;
    const tenantId = this.accountSnapshot.tenant_id!;

    const decrypted = withDecryptedCredentials(this.accountSnapshot);
    const client = createImapClient(decrypted);
    this.client = client;
    this.bindClientEvents(client);

    await client.connect();
    idleDiag('IMAP_CONNECTED', { accountId, tenantId });

    try {
      // Keep INBOX selected for the whole session (documented monitor pattern).
      // Do NOT hold a long-lived getMailboxLock: it is a mutex and is not needed
      // when this listener is the only user of the client.
      const inbox = await openInbox(client);
      idleDiag('INBOX_OPENED', {
        accountId,
        tenantId,
        uidValidity: inbox.uidValidity,
        uidNext: inbox.uidNext,
        exists: inbox.exists,
      });

      // Attach exists handler before entering IDLE so no notification is missed.
      this.existsHandler = (data?: { path?: string; count?: number; prevCount?: number }) => {
        const count = Number(data?.count ?? 0);
        const prevCount = Number(data?.prevCount ?? 0);
        idleDiag('EXISTS_RECEIVED', {
          accountId,
          tenantId,
          path: data?.path,
          prevCount,
          count,
          lastSyncUid: Number(this.accountSnapshot.last_sync_uid || 0),
        });
        // Only a real increase means new messages to fetch.
        if (shouldFetchOnExists(count, prevCount)) {
          this.enqueueFetch(client);
        }
      };
      client.on('exists', this.existsHandler);

      // Startup / catch-up reconciliation before IDLE (recovers missed messages).
      await this.runReconciliation(client);

      if (!isInboxOpen(client)) {
        throw new Error('INBOX not selected after reconciliation');
      }
      await this.setDbStatus('IDLE', null, true);
      this.reconnectAttempt = 0;
      idleDiag('IDLE_ENTERED', {
        accountId,
        tenantId,
        lastSyncUid: Number(this.accountSnapshot.last_sync_uid || 0),
      });

      while (!this.stopRequested && !this.connectionLost && client.usable) {
        if (Date.now() - this.lastReconcileAt >= this.reconcileEveryMs) {
          await this.runReconciliation(client);
        }

        if (!isInboxOpen(client)) {
          // Mailbox was unexpectedly deselected; re-open before idling again.
          await openInbox(client);
        }

        try {
          // Single controlled IDLE. Returns after maxIdleTime (renew) or when a
          // command (fetch triggered by exists) breaks it.
          const idleStart = Date.now();
          await client.idle();
          const elapsedMs = Date.now() - idleStart;
          if (!this.stopRequested && !this.connectionLost && client.usable) {
            idleDiag('IDLE_RENEWED', { accountId, tenantId, elapsedMs });
            // Defensive: if idle() returned almost immediately (e.g. the client
            // was already idling due to socket-timeout recovery), avoid a tight
            // CPU loop before idling again.
            if (elapsedMs < 1000) {
              await sleep(250);
            }
          }
        } catch (idleErr) {
          if (!this.intentionalClose && !this.stopRequested) {
            this.handleConnectionLost(idleErr, 'error');
          }
          break;
        }

        if (this.stopRequested || this.connectionLost) break;
        // Drain any exists-triggered fetch before idling again; also catch messages
        // that may have arrived during the IDLE renewal gap.
        await this.fetchChain;
      }
    } finally {
      await this.teardownClient();
    }

    if (this.authFailedPermanently) {
      throw this.connectionLostError || new Error('IMAP authentication failed');
    }
    if (this.connectionLost && !this.stopRequested) {
      throw this.connectionLostError || new Error('IMAP connection lost');
    }
    if (!this.stopRequested) {
      throw new Error('IMAP IDLE connection closed');
    }
  }

  private bindClientEvents(client: ImapFlow): void {
    const onError = (err: Error) => {
      if (this.intentionalClose || this.stopRequested) return;
      console.error(
        `IMAP socket error for account #${this.accountSnapshot.id}:`,
        safeImapErrorMessage(err)
      );
      this.handleConnectionLost(err, 'error');
    };
    const onClose = () => {
      if (this.intentionalClose || this.stopRequested) return;
      this.handleConnectionLost(null, 'close');
    };
    client.on('error', onError);
    client.on('close', onClose);
    this.clientEventHandlers = { error: onError, close: onClose };
  }

  private unbindClientEvents(client: ImapFlow): void {
    if (this.clientEventHandlers) {
      client.removeListener('error', this.clientEventHandlers.error);
      client.removeListener('close', this.clientEventHandlers.close);
      this.clientEventHandlers = null;
    }
    if (this.existsHandler) {
      client.removeListener('exists', this.existsHandler);
      this.existsHandler = null;
    }
  }

  private handleConnectionLost(error: unknown | null, source: 'error' | 'close'): void {
    if (this.intentionalClose || this.stopRequested) return;
    if (!this.connectionLostGuard.tryHandle()) return;

    this.connectionLost = true;
    this.connectionLostError = error;

    if (error && isImapAuthError(error)) {
      this.authFailedPermanently = true;
      void this.setDbStatus('ERROR', safeImapErrorMessage(error), false);
      return;
    }

    const safe =
      error != null
        ? safeImapErrorMessage(error)
        : source === 'close'
          ? 'IMAP bağlantısı kapandı'
          : 'IMAP bağlantı hatası';
    void this.setDbStatus('RECONNECTING', safe, false);
  }

  private enqueueFetch(client: ImapFlow): void {
    this.fetchChain = this.fetchChain
      .then(() => this.fetchNewUids(client))
      .catch((err) => {
        console.error(
          `IDLE fetch error for account #${this.accountSnapshot.id}:`,
          safeImapErrorMessage(err)
        );
      });
  }

  private async fetchNewUids(client: ImapFlow): Promise<void> {
    if (!client.usable || this.stopRequested) return;

    const fresh = await this.reloadAccountRow();
    if (!fresh || !fresh.is_active) {
      this.stopRequested = true;
      return;
    }
    this.accountSnapshot = fresh;

    const sinceUid = Number(fresh.last_sync_uid || 0);
    const { messages, meta, highestUid } = await fetchMessagesByUidRange(
      client,
      fresh.id,
      sinceUid
    );
    idleDiag('UID_RANGE_FETCHED', {
      accountId: fresh.id,
      tenantId: fresh.tenant_id,
      sinceUid,
      fetched: messages.length,
      highestUid,
      trigger: 'exists',
    });

    if (messages.length === 0) {
      if (highestUid > sinceUid) {
        await query(
          `UPDATE mail_accounts
           SET last_sync_uid = GREATEST(COALESCE(last_sync_uid, 0), $1),
               imap_uidvalidity = $2,
               last_sync_at = CURRENT_TIMESTAMP
           WHERE id = $3 AND tenant_id = $4`,
          [highestUid, meta.uidValidity, fresh.id, fresh.tenant_id]
        );
      }
      return;
    }

    // last_sync_uid only advances after successful persist inside this call.
    await this.fetchService.persistFetchedMessages(fresh, messages, {
      uidValidity: meta.uidValidity,
    });

    const updated = await this.reloadAccountRow();
    if (updated) this.accountSnapshot = updated;
  }

  private async runReconciliation(client: ImapFlow): Promise<void> {
    const fresh = await this.reloadAccountRow();
    if (!fresh) return;
    this.accountSnapshot = fresh;

    const storedValidity =
      fresh.imap_uidvalidity != null ? Number(fresh.imap_uidvalidity) : null;
    const meta = await readMailboxMeta(client);

    let sinceUid = Number(fresh.last_sync_uid || 0);
    idleDiag('RECONCILE_STARTED', {
      accountId: fresh.id,
      tenantId: fresh.tenant_id,
      lastSyncUid: sinceUid,
      uidNext: meta.uidNext,
      uidValidity: meta.uidValidity,
    });

    if (storedValidity && meta.uidValidity && storedValidity !== meta.uidValidity) {
      console.warn(
        `UIDVALIDITY changed for account #${fresh.id}; rematching recent messages`
      );
      sinceUid = 0;
    }

    const { messages, highestUid } = await fetchMessagesByUidRange(
      client,
      fresh.id,
      sinceUid
    );
    idleDiag('UID_RANGE_FETCHED', {
      accountId: fresh.id,
      tenantId: fresh.tenant_id,
      sinceUid,
      fetched: messages.length,
      highestUid,
      trigger: 'reconcile',
    });

    if (messages.length > 0) {
      await this.fetchService.persistFetchedMessages(fresh, messages, {
        uidValidity: meta.uidValidity,
      });
    } else {
      await query(
        `UPDATE mail_accounts
         SET last_sync_uid = GREATEST(COALESCE(last_sync_uid, 0), $1),
             imap_uidvalidity = $2,
             last_sync_at = CURRENT_TIMESTAMP,
             sync_status = 'idle',
             sync_error = NULL
         WHERE id = $3 AND tenant_id = $4`,
        [Math.max(sinceUid, highestUid), meta.uidValidity, fresh.id, fresh.tenant_id]
      );
    }

    this.lastReconcileAt = Date.now();
    const updated = await this.reloadAccountRow();
    if (updated) this.accountSnapshot = updated;
  }

  private async reloadAccountRow(): Promise<MailAccount | null> {
    const result = await query(
      `SELECT * FROM mail_accounts WHERE id = $1 AND tenant_id = $2`,
      [this.accountSnapshot.id, this.accountSnapshot.tenant_id]
    );
    return (result.rows[0] as MailAccount) || null;
  }

  private async teardownClient(): Promise<void> {
    this.intentionalClose = true;
    const client = this.client;
    this.client = null;
    if (!client) return;

    this.unbindClientEvents(client);

    try {
      await client.logout();
    } catch {
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }
  }

  private async setDbStatus(
    status: IdleConnectionState,
    error: string | null,
    listenerActive: boolean
  ): Promise<void> {
    this.state = status;
    // Do not reuse the status placeholder inside CASE branches that return
    // timestamp/varchar — PostgreSQL then fails with:
    // "inconsistent types deduced for parameter $1"
    const isIdle = status === 'IDLE';
    const isError = status === 'ERROR';
    try {
      await query(
        `UPDATE mail_accounts
         SET imap_idle_status = $1,
             imap_idle_error = $2,
             imap_listener_active = $3,
             imap_connected_at = CASE WHEN $4 THEN CURRENT_TIMESTAMP ELSE imap_connected_at END,
             imap_connection_status = CASE
               WHEN $5 THEN 'ok'
               WHEN $6 THEN 'error'
               ELSE imap_connection_status
             END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $7 AND tenant_id = $8`,
        [
          status,
          error,
          listenerActive,
          isIdle,
          isIdle,
          isError,
          this.accountSnapshot.id,
          this.accountSnapshot.tenant_id,
        ]
      );
    } catch (err: any) {
      console.error('Failed to update IMAP idle status:', err?.message || err);
    }
  }
}

export class ImapConnectionManager {
  private listeners = new Map<number, AccountIdleListener>();
  private accountSub: Redis | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private started = false;

  async start(): Promise<void> {
    if (this.started) return;
    if (!isImapIdleEnabled()) {
      console.log('IMAP IDLE disabled (IMAP_IDLE_ENABLED=false)');
      return;
    }

    this.started = true;
    console.log('✓ Starting ImapConnectionManager');

    await this.syncListenersFromDb();

    this.accountSub = subscribeMailAccountEvents((event) => this.onAccountEvent(event));

    const watchMs = getImapAccountWatchIntervalSeconds() * 1000;
    this.watchTimer = setInterval(() => {
      void this.syncListenersFromDb().catch((err) => {
        console.error('IMAP account watch error:', err?.message || err);
      });
    }, watchMs);
    if (typeof this.watchTimer.unref === 'function') {
      this.watchTimer.unref();
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.accountSub) {
      try {
        await this.accountSub.quit();
      } catch {
        /* ignore */
      }
      this.accountSub = null;
    }

    const stops = [...this.listeners.values()].map((l) => l.stop());
    this.listeners.clear();
    await Promise.allSettled(stops);
    console.log('✓ ImapConnectionManager stopped');
  }

  private async onAccountEvent(event: MailAccountEvent): Promise<void> {
    if (event.type === 'ACCOUNT_DELETED' || event.type === 'ACCOUNT_DISABLED') {
      await this.removeListener(event.accountId);
      return;
    }

    const result = await query(
      `SELECT * FROM mail_accounts WHERE id = $1 AND tenant_id = $2`,
      [event.accountId, event.tenantId]
    );
    const account = result.rows[0] as MailAccount | undefined;
    if (!account || !account.is_active) {
      await this.removeListener(event.accountId);
      return;
    }

    await this.upsertListener(account, event.type === 'ACCOUNT_UPDATED');
  }

  private async syncListenersFromDb(): Promise<void> {
    const result = await query(
      `SELECT * FROM mail_accounts
       WHERE is_active = true
         AND tenant_id NOT IN (
           SELECT id FROM tenants WHERE storage_used_mb >= storage_limit_mb
         )`
    );
    const accounts = result.rows as MailAccount[];
    const activeIds = new Set(accounts.map((a) => a.id));

    for (const account of accounts) {
      await this.upsertListener(account, false);
    }

    for (const accountId of [...this.listeners.keys()]) {
      if (!activeIds.has(accountId)) {
        await this.removeListener(accountId);
      }
    }
  }

  private async upsertListener(account: MailAccount, forceRestart: boolean): Promise<void> {
    const existing = this.listeners.get(account.id);
    if (existing) {
      // Only restart when a real connection setting changed. Unchanged accounts
      // keep their live IDLE session even if ACCOUNT_UPDATED fired or the watch
      // re-queried the row.
      const changed =
        existing.getConnectionFingerprint() !== connectionFingerprint(account);
      if (forceRestart && changed) {
        await existing.stop();
        this.listeners.delete(account.id);
      } else {
        existing.updateAccount(account);
        return;
      }
    }

    const listener = new AccountIdleListener(account);
    this.listeners.set(account.id, listener);
    listener.start();
    console.log(`✓ IMAP IDLE listener started for account #${account.id}`);
  }

  private async removeListener(accountId: number): Promise<void> {
    const existing = this.listeners.get(accountId);
    if (!existing) return;
    this.listeners.delete(accountId);
    await existing.stop();
    console.log(`✓ IMAP IDLE listener stopped for account #${accountId}`);
  }

  getListenerStates(): Array<{ accountId: number; state: IdleConnectionState }> {
    return [...this.listeners.entries()].map(([accountId, listener]) => ({
      accountId,
      state: listener.getState(),
    }));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let singleton: ImapConnectionManager | null = null;

export function getImapConnectionManager(): ImapConnectionManager {
  if (!singleton) {
    singleton = new ImapConnectionManager();
  }
  return singleton;
}
