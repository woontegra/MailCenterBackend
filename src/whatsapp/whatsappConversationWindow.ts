import { query } from '../config/database';

const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Meta customer service window: free-form (non-template) messages are only
 * allowed within 24 hours after the WhatsApp user last messaged the business.
 * We only trust inbound_messages we received via verified webhooks.
 */
export async function hasOpenWhatsAppServiceWindow(params: {
  tenantId: number;
  channelConnectionId: number;
  userPhoneDigits: string;
}): Promise<{ open: boolean; lastInboundAt: Date | null }> {
  const digits = String(params.userPhoneDigits || '').replace(/\D/g, '');
  if (!digits) return { open: false, lastInboundAt: null };

  const result = await query(
    `SELECT received_at
     FROM inbound_messages
     WHERE tenant_id = $1
       AND channel_connection_id = $2
       AND channel_type = 'WHATSAPP'
       AND regexp_replace(sender_value, '\\D', '', 'g') = $3
     ORDER BY received_at DESC
     LIMIT 1`,
    [params.tenantId, params.channelConnectionId, digits]
  );

  if (result.rows.length === 0) {
    return { open: false, lastInboundAt: null };
  }

  const last = new Date(result.rows[0].received_at);
  const open = Date.now() - last.getTime() <= WINDOW_MS;
  return { open, lastInboundAt: last };
}

/** Monotonic status ranks — never move backwards (except FAILED from early states). */
const STATUS_RANK: Record<string, number> = {
  QUEUED: 0,
  SCHEDULED: 0,
  PROCESSING: 1,
  SENT: 2,
  DELIVERED: 3,
  READ: 4,
  FAILED: -1,
  CANCELLED: -1,
};

export function canAdvanceOutboundStatus(current: string, next: string): boolean {
  if (current === next) return false;
  if (current === 'CANCELLED') return false;
  if (current === 'READ') return false;
  if (next === 'FAILED') {
    return ['QUEUED', 'SCHEDULED', 'PROCESSING', 'SENT', 'DELIVERED'].includes(current);
  }
  const cur = STATUS_RANK[current];
  const nxt = STATUS_RANK[next];
  if (cur == null || nxt == null || nxt < 0) return false;
  return nxt > cur;
}

export function mapMetaStatusToOutbound(
  status: 'sent' | 'delivered' | 'read' | 'failed'
): 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' {
  if (status === 'sent') return 'SENT';
  if (status === 'delivered') return 'DELIVERED';
  if (status === 'read') return 'READ';
  return 'FAILED';
}
