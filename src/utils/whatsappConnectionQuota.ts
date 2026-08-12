import { query } from '../config/database';

/** Statuses that consume WhatsApp channel plan quota. */
export function isWhatsAppQuotaConsumingStatus(status: unknown): boolean {
  return String(status || '').toUpperCase() === 'ACTIVE';
}

/**
 * Whether creating/updating a WhatsApp connection should consume a new quota slot.
 * Reactivating DISABLED/ERROR/etc → ACTIVE consumes; updating an already-ACTIVE row does not.
 */
export function shouldConsumeWhatsAppConnectionQuota(params: {
  isNewRow: boolean;
  previousStatus?: string | null;
  nextStatus: string;
}): boolean {
  if (!isWhatsAppQuotaConsumingStatus(params.nextStatus)) return false;
  if (params.isNewRow) return true;
  return !isWhatsAppQuotaConsumingStatus(params.previousStatus);
}

/** Live count of tenant WhatsApp connections that consume plan quota. */
export async function countWhatsAppConnectionsTowardQuota(tenantId: number): Promise<number> {
  const result = await query(
    `SELECT COUNT(*)::int AS c
     FROM channel_connections
     WHERE tenant_id = $1
       AND channel_type = 'WHATSAPP'
       AND UPPER(COALESCE(status, '')) = 'ACTIVE'`,
    [tenantId]
  );
  return Number(result.rows[0]?.c || 0);
}
