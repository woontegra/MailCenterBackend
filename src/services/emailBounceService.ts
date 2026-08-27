import { query } from '../config/database';
import { upsertSuppression } from './suppressionService';
import {
  recordDeliveryLifecycleEvent,
  recordEmailTrackingEvent,
} from './emailTrackingEventService';

const HARD_BOUNCE_CODES = new Set([
  'INVALID_ADDRESS',
  'DOMAIN_POLICY',
  'RECIPIENT_BLOCKED',
  'NO_RECIPIENT',
  '550',
  '551',
  '552',
  '553',
  '554',
]);

const SOFT_BOUNCE_CODES = new Set(['RATE_LIMIT', 'SMTP_FAILED', '421', '450', '451', '452']);

export function classifySmtpFailure(code?: string | null): 'hard' | 'soft' | 'unknown' {
  const c = String(code || '').toUpperCase();
  if (HARD_BOUNCE_CODES.has(c) || /^5\d{2}$/.test(c)) return 'hard';
  if (SOFT_BOUNCE_CODES.has(c) || /^4\d{2}$/.test(c)) return 'soft';
  return 'unknown';
}

export async function handleCampaignRecipientDeliveryFailure(params: {
  tenantId: number;
  campaignId: number;
  campaignRecipientId: number;
  outboundMessageId?: number | null;
  email?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  attemptCount?: number;
}) {
  const kind = classifySmtpFailure(params.errorCode);
  const isFinalHard = kind === 'hard';
  const isFinalSoft =
    kind === 'soft' && Number(params.attemptCount || 0) >= 3;

  const eventType = isFinalHard || isFinalSoft ? 'PERM_DELIVERY_FAILURE' : 'TEMP_DELIVERY_FAILURE';

  await recordDeliveryLifecycleEvent({
    tenantId: params.tenantId,
    campaignId: params.campaignId,
    campaignRecipientId: params.campaignRecipientId,
    outboundMessageId: params.outboundMessageId,
    eventType,
    meta: {
      error_code: params.errorCode || null,
      error_message: params.errorMessage ? String(params.errorMessage).slice(0, 200) : null,
    },
  });

  if ((isFinalHard || isFinalSoft) && params.email) {
    await upsertSuppression({
      tenantId: params.tenantId,
      email: params.email,
      reason: 'BOUNCE_PERMANENT',
      source: 'smtp_failure',
      campaignId: params.campaignId,
    });
  }
}

export async function handleCampaignRecipientSmtpAccepted(params: {
  tenantId: number;
  brandId?: number | null;
  campaignId: number;
  campaignRecipientId: number;
  outboundMessageId: number;
  contactId?: number | null;
  providerMessageId?: string | null;
}) {
  await recordDeliveryLifecycleEvent({
    tenantId: params.tenantId,
    brandId: params.brandId,
    campaignId: params.campaignId,
    campaignRecipientId: params.campaignRecipientId,
    outboundMessageId: params.outboundMessageId,
    contactId: params.contactId,
    eventType: 'SMTP_ACCEPTED',
    meta: { provider_message_id: params.providerMessageId || null },
  });
}

/** Only call when provider webhook/DSN gives reliable delivery proof */
export async function handleProviderDeliveredProof(params: {
  tenantId: number;
  campaignId: number;
  campaignRecipientId: number;
  outboundMessageId?: number | null;
  source: 'dsn' | 'provider_webhook';
  providerPayloadRef?: string;
}) {
  await recordDeliveryLifecycleEvent({
    tenantId: params.tenantId,
    campaignId: params.campaignId,
    campaignRecipientId: params.campaignRecipientId,
    outboundMessageId: params.outboundMessageId,
    eventType: 'DELIVERED',
    dedupeSuffix: params.source,
    meta: { proof_source: params.source, payload_ref: params.providerPayloadRef || null },
  });
}

export async function handleSpamComplaint(params: {
  tenantId: number;
  campaignId?: number | null;
  campaignRecipientId?: number | null;
  email: string;
  source?: string;
}) {
  if (params.campaignRecipientId && params.campaignId) {
    await recordEmailTrackingEvent({
      tenantId: params.tenantId,
      campaignId: params.campaignId,
      campaignRecipientId: params.campaignRecipientId,
      eventType: 'SPAM_COMPLAINT',
      eventKey: `complaint:${params.campaignRecipientId}`,
      meta: { source: params.source || 'provider' },
    });
  }

  await upsertSuppression({
    tenantId: params.tenantId,
    email: params.email,
    reason: 'SPAM_COMPLAINT',
    source: params.source || 'complaint',
    campaignId: params.campaignId || undefined,
  });
}

/** Optional DSN ingest stub — parses minimal permanent failure signals from inbound DSN subject/body */
export function parseDsnSignals(raw: string): { hardBounce: boolean; recipient?: string } | null {
  const text = String(raw || '');
  if (!/\b(delivery status notification|undeliverable|failed permanently|status:\s*5)/i.test(text)) {
    return null;
  }
  const emailMatch = text.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
  return {
    hardBounce: /\b(status:\s*5|permanent|550|554)\b/i.test(text),
    recipient: emailMatch?.[0],
  };
}

export async function ingestDsnForCampaignRecipient(params: {
  tenantId: number;
  campaignRecipientId: number;
  rawDsn: string;
}) {
  const parsed = parseDsnSignals(params.rawDsn);
  if (!parsed?.hardBounce) return { handled: false };

  const rec = await query(
    `SELECT cr.*, c.brand_id FROM campaign_recipients cr
     JOIN campaigns c ON c.id = cr.campaign_id AND c.tenant_id = cr.tenant_id
     WHERE cr.id = $1 AND cr.tenant_id = $2`,
    [params.campaignRecipientId, params.tenantId]
  );
  const row = rec.rows[0];
  if (!row) return { handled: false };

  await handleCampaignRecipientDeliveryFailure({
    tenantId: params.tenantId,
    campaignId: Number(row.campaign_id),
    campaignRecipientId: params.campaignRecipientId,
    outboundMessageId: row.outbound_message_id,
    email: parsed.recipient || row.email,
    errorCode: 'DSN_HARD_BOUNCE',
    errorMessage: 'Kalıcı teslim hatası (DSN)',
    attemptCount: 99,
  });

  return { handled: true };
}
