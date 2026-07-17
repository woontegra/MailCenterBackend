import Redis from 'ioredis';
import redis from '../config/redis';

export type MailAccountEventType =
  | 'ACCOUNT_CREATED'
  | 'ACCOUNT_UPDATED'
  | 'ACCOUNT_DISABLED'
  | 'ACCOUNT_DELETED';

export interface MailAccountEvent {
  type: MailAccountEventType;
  tenantId: number;
  accountId: number;
  at: string;
}

export interface InboxRealtimeEvent {
  type: 'conversation_updated' | 'new_mail';
  tenantId: number;
  conversationId?: number;
  mailId?: number;
  accountId?: number;
  subject?: string;
  from?: string;
  at: string;
}

export const MAIL_ACCOUNT_EVENTS_CHANNEL = 'mailcenter:mail-account-events';
export const INBOX_REALTIME_CHANNEL = 'mailcenter:inbox-realtime';

function createSubscriber(): Redis {
  return redis.duplicate();
}

export async function publishMailAccountEvent(event: Omit<MailAccountEvent, 'at'>): Promise<void> {
  const payload: MailAccountEvent = { ...event, at: new Date().toISOString() };
  try {
    await redis.publish(MAIL_ACCOUNT_EVENTS_CHANNEL, JSON.stringify(payload));
  } catch (error: any) {
    console.error('Failed to publish mail account event:', error?.message || error);
  }
}

export async function publishInboxRealtime(event: Omit<InboxRealtimeEvent, 'at'>): Promise<void> {
  const payload: InboxRealtimeEvent = { ...event, at: new Date().toISOString() };
  try {
    await redis.publish(INBOX_REALTIME_CHANNEL, JSON.stringify(payload));
  } catch (error: any) {
    console.error('Failed to publish inbox realtime event:', error?.message || error);
  }
}

export function subscribeMailAccountEvents(
  handler: (event: MailAccountEvent) => void | Promise<void>
): Redis {
  const sub = createSubscriber();
  sub.subscribe(MAIL_ACCOUNT_EVENTS_CHANNEL).catch((err) => {
    console.error('Mail account event subscribe failed:', err?.message || err);
  });
  sub.on('message', (_channel, message) => {
    try {
      const parsed = JSON.parse(message) as MailAccountEvent;
      void Promise.resolve(handler(parsed)).catch((err) => {
        console.error('Mail account event handler error:', err?.message || err);
      });
    } catch {
      /* ignore malformed */
    }
  });
  return sub;
}

export function subscribeInboxRealtime(
  handler: (event: InboxRealtimeEvent) => void | Promise<void>
): Redis {
  const sub = createSubscriber();
  sub.subscribe(INBOX_REALTIME_CHANNEL).catch((err) => {
    console.error('Inbox realtime subscribe failed:', err?.message || err);
  });
  sub.on('message', (_channel, message) => {
    try {
      const parsed = JSON.parse(message) as InboxRealtimeEvent;
      void Promise.resolve(handler(parsed)).catch((err) => {
        console.error('Inbox realtime handler error:', err?.message || err);
      });
    } catch {
      /* ignore malformed */
    }
  });
  return sub;
}
