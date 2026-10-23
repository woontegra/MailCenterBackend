/**
 * Production wiring for the coexistence webhook processor.
 */
import { query } from '../config/database';
import {
  CoexistenceProcessorDeps,
  drainCoexistenceEvents,
} from './whatsappCoexistenceProcessor';
import {
  findWhatsAppConnectionByPhoneNumberId,
  findWhatsAppConnectionsByWabaId,
  resolveContactId,
} from './whatsappWebhookService';
import { ensurePhoneChannelConversation, touchConversationOutbound } from './conversationService';
import {
  getRemainingQuota,
  getTenantEntitlements,
  recalculateCountUsage,
} from './entitlementService';
import { publishInboxRealtime } from './redisEventBus';
import { emitToTenant } from './socketService';
import { fetchPhoneCoexistenceStatus } from './metaEmbeddedSignupService';
import { unpackWhatsAppCredentials } from '../whatsapp/whatsappCredentials';
import { classifyCoexistenceLookup } from '../whatsapp/coexistenceWebhook';

export function createCoexistenceProcessorDeps(): CoexistenceProcessorDeps {
  return {
    db: { query },
    findConnectionsByPhoneNumberId: findWhatsAppConnectionByPhoneNumberId,
    findConnectionsByWabaId: findWhatsAppConnectionsByWabaId,
    ensureConversation: (params) =>
      ensurePhoneChannelConversation({
        tenantId: params.tenantId,
        brandId: params.brandId,
        channelType: 'WHATSAPP',
        channelConnectionId: params.channelConnectionId,
        phoneRaw: params.phoneRaw,
        contactId: params.contactId,
        createStatus: params.createStatus,
        emitAutomation: false,
      }),
    touchConversationOutbound: (params) => touchConversationOutbound(params),
    resolveContactId,
    getRemainingContactQuota: async (tenantId) => {
      const ent = await getTenantEntitlements(tenantId);
      return getRemainingQuota(ent.limits.max_contacts, Number(ent.usage.contacts_count || 0));
    },
    afterContactsCreated: async (tenantId) => {
      await recalculateCountUsage(tenantId);
    },
    notifyConversationUpdated: async (tenantId, conversationId) => {
      try {
        emitToTenant(tenantId, 'conversation_updated', { conversationId, channel: 'WHATSAPP' });
        await publishInboxRealtime({
          type: 'conversation_updated',
          tenantId,
          conversationId: conversationId ?? undefined,
          accountId: undefined,
        });
      } catch {
        /* realtime non-fatal */
      }
    },
    verifyConnectionCoexistence: async (connection) => {
      const phoneNumberId = String(connection?.settings?.phone_number_id || '').trim();
      if (!phoneNumberId) return { state: 'UNKNOWN', isOnBizApp: null, platformType: null };
      try {
        const { accessToken } = unpackWhatsAppCredentials(connection.encrypted_credentials);
        const lookup = await fetchPhoneCoexistenceStatus({ accessToken, phoneNumberId });
        return { state: classifyCoexistenceLookup(lookup), ...lookup };
      } catch {
        return { state: 'UNKNOWN', isOnBizApp: null, platformType: null };
      }
    },
    now: () => new Date(),
  };
}

let draining = false;
let rerun = false;

/** Fire-and-forget drain; coalesces concurrent triggers within this process. */
export function scheduleCoexistenceDrain(): void {
  if (draining) {
    rerun = true;
    return;
  }
  draining = true;
  setImmediate(async () => {
    try {
      do {
        rerun = false;
        await drainCoexistenceEvents(createCoexistenceProcessorDeps());
      } while (rerun);
    } catch (error: any) {
      // 42P01: whatsapp_coexistence_upgrade.sql not applied yet
      if (error?.code === '42P01') return;
      console.error(
        JSON.stringify({
          event: 'whatsapp_coexistence_drain_error',
          message: String(error?.message || 'unknown').slice(0, 200),
        })
      );
    } finally {
      draining = false;
    }
  });
}

/** Processed raw payloads contain message bodies; keep them only as long as needed. */
export async function pruneProcessedCoexistenceEvents(retentionDays = 30): Promise<number> {
  const res = await query(
    `DELETE FROM whatsapp_webhook_events
     WHERE status IN ('PROCESSED', 'IGNORED')
       AND processed_at < CURRENT_TIMESTAMP - ($1::int * INTERVAL '1 day')`,
    [retentionDays]
  );
  return Number(res.rowCount || 0);
}
