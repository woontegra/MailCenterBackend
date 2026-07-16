import { query } from '../config/database';
import { normalizePhone, getTenantDefaultCountryCode } from '../utils/contactNormalize';
import { unpackWhatsAppCredentials } from '../whatsapp/whatsappCredentials';
import { WhatsAppParsedWebhookEvent } from '../whatsapp/WhatsAppProviderAdapter';
import {
  mapMetaStatusToOutbound,
} from '../whatsapp/whatsappConversationWindow';
import { advanceOutboundDeliveryStatus } from './outboundMessageService';
import { sanitizeOutboundErrorMessage } from '../config/outboundQueue';
import { linkInboundWhatsAppMessage } from './conversationService';

export async function findWhatsAppConnectionByPhoneNumberId(phoneNumberId: string) {
  const result = await query(
    `SELECT *
     FROM channel_connections
     WHERE channel_type = 'WHATSAPP'
       AND UPPER(COALESCE(provider, '')) = 'META_WHATSAPP_CLOUD'
       AND settings->>'phone_number_id' = $1`,
    [phoneNumberId]
  );
  return result.rows;
}

export async function findWhatsAppConnectionsByVerifyToken(verifyToken: string) {
  const result = await query(
    `SELECT *
     FROM channel_connections
     WHERE channel_type = 'WHATSAPP'
       AND UPPER(COALESCE(provider, '')) = 'META_WHATSAPP_CLOUD'
       AND encrypted_credentials IS NOT NULL`
  );
  const matches = [];
  for (const row of result.rows) {
    try {
      const creds = unpackWhatsAppCredentials(row.encrypted_credentials);
      if (creds.webhookVerifyToken === verifyToken) matches.push(row);
    } catch {
      /* skip */
    }
  }
  return matches;
}

async function resolveContactId(
  tenantId: number,
  phoneRaw: string
): Promise<number | null> {
  const digits = String(phoneRaw || '').replace(/\D/g, '');
  if (!digits) return null;

  let normalized = `+${digits}`;
  const phone = normalizePhone({
    value: phoneRaw.startsWith('+') ? phoneRaw : `+${digits}`,
    countryCode: null,
  });
  if (phone.ok) normalized = phone.normalized;
  else {
    const cc = await getTenantDefaultCountryCode(tenantId);
    const again = normalizePhone({ value: phoneRaw, countryCode: cc });
    if (again.ok) normalized = again.normalized;
  }

  const point = await query(
    `SELECT contact_id FROM contact_points
     WHERE tenant_id = $1
       AND channel_type IN ('WHATSAPP', 'SMS')
       AND is_active = true
       AND (
         normalized_value = $2
         OR regexp_replace(normalized_value, '\\D', '', 'g') = $3
       )
     LIMIT 1`,
    [tenantId, normalized, digits]
  );
  return point.rows[0]?.contact_id || null;
}

export async function processMetaWhatsAppWebhookEvents(params: {
  phoneNumberId: string;
  events: WhatsAppParsedWebhookEvent[];
}) {
  const connections = await findWhatsAppConnectionByPhoneNumberId(params.phoneNumberId);
  if (connections.length === 0) return { processed: 0 };

  let processed = 0;
  for (const connection of connections) {
    for (const event of params.events) {
      if (event.phoneNumberId !== params.phoneNumberId) continue;

      if (event.kind === 'status') {
        const next = mapMetaStatusToOutbound(event.status);
        await advanceOutboundDeliveryStatus({
          tenantId: connection.tenant_id,
          providerMessageId: event.providerMessageId,
          nextStatus: next,
          errorCode: event.errorCode,
          errorMessage: event.errorTitle
            ? sanitizeOutboundErrorMessage(event.errorTitle)
            : null,
        });
        processed += 1;
        continue;
      }

      if (event.kind === 'inbound') {
        const contactId = await resolveContactId(connection.tenant_id, event.from);
        const receivedAt = event.timestamp
          ? new Date(Number(event.timestamp) * 1000)
          : new Date();

        try {
          const insert = await query(
            `INSERT INTO inbound_messages (
               tenant_id, brand_id, channel_connection_id, channel_type,
               sender_value, recipient_value, provider_message_id, message_type,
               content, media_metadata, received_at, contact_id, status
             ) VALUES (
               $1,$2,$3,'WHATSAPP',$4,$5,$6,$7,$8,$9::jsonb,$10,$11,'RECEIVED'
             )
             ON CONFLICT (tenant_id, channel_type, provider_message_id) DO NOTHING
             RETURNING id`,
            [
              connection.tenant_id,
              connection.brand_id,
              connection.id,
              event.from,
              connection.settings?.business_phone_number || null,
              event.providerMessageId,
              event.messageType,
              event.textBody,
              JSON.stringify(event.mediaMetadata || {}),
              Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
              contactId,
            ]
          );
          if (insert.rows[0]?.id) {
            try {
              await linkInboundWhatsAppMessage({
                tenantId: connection.tenant_id,
                brandId: connection.brand_id,
                channelConnectionId: connection.id,
                inboundMessageId: insert.rows[0].id,
                fromPhone: event.from,
                contactId,
                receivedAt: Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
              });
            } catch (linkErr) {
              console.error('Error linking WhatsApp inbound to conversation');
            }
            try {
              const { emitAutomationEvent } = await import('./automationEmitter');
              await emitAutomationEvent({
                tenantId: connection.tenant_id,
                triggerType: 'INBOUND_WHATSAPP_RECEIVED',
                triggerEventId: `inbound:${insert.rows[0].id}`,
                payload: {
                  inboundMessageId: insert.rows[0].id,
                  brandId: connection.brand_id,
                  channel: 'WHATSAPP',
                  contactId,
                  fromAddress: event.from,
                  messagePreview: String(event.textBody || '').slice(0, 400),
                },
              });
            } catch (autoErr) {
              console.error('Automation WhatsApp emit error:', autoErr);
            }
          }
          processed += 1;
        } catch (error: any) {
          if (error.code !== '23505') throw error;
        }
      }
    }
  }

  return { processed };
}
