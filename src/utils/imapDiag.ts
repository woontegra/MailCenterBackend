export type IdleDiagEvent =
  | 'IMAP_CONNECTED'
  | 'INBOX_OPENED'
  | 'IDLE_ENTERED'
  | 'EXISTS_RECEIVED'
  | 'RECONCILE_STARTED'
  | 'UID_RANGE_FETCHED'
  | 'MESSAGE_PERSISTED'
  | 'IDLE_RENEWED';

/**
 * Production-safe IMAP IDLE diagnostics.
 *
 * Only non-sensitive operational fields may be logged: tenantId, accountId,
 * uid/count values and durations. NEVER log subject, from/to, body, credentials
 * or any message content.
 */
export function idleDiag(
  event: IdleDiagEvent,
  fields: Record<string, number | string | undefined>
): void {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  console.log(`[IMAP_IDLE] ${event} ${parts}`.trim());
}
