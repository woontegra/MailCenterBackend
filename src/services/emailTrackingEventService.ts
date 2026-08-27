import crypto from 'crypto';
import { query } from '../config/database';
import {
  classifyTrackingRequest,
  TrackingClassification,
} from '../utils/emailTrackingBotClassifier';

export type { TrackingClassification };

export function hashIpForStorage(ip?: string | null): string | null {
  if (!ip) return null;
  return crypto.createHash('sha256').update(`mc-ip:${ip}`).digest('hex').slice(0, 32);
}

export type EmailTrackingEventType =
  | 'QUEUED'
  | 'SEND_ATTEMPTED'
  | 'SMTP_ACCEPTED'
  | 'DELIVERED'
  | 'TEMP_DELIVERY_FAILURE'
  | 'PERM_DELIVERY_FAILURE'
  | 'OPEN_DETECTED'
  | 'LINK_CLICKED'
  | 'FILE_DOWNLOADED'
  | 'SITE_VISIT_VERIFIED'
  | 'CONVERSION_COMPLETED'
  | 'UNSUBSCRIBED'
  | 'SPAM_COMPLAINT';

function buildEventKey(parts: (string | number | null | undefined)[]): string {
  return parts.filter((p) => p !== null && p !== undefined).join(':');
}

async function ensureEngagementRow(params: {
  tenantId: number;
  campaignId: number;
  campaignRecipientId: number;
}) {
  await query(
    `INSERT INTO email_recipient_engagement (campaign_recipient_id, tenant_id, campaign_id)
     VALUES ($1,$2,$3)
     ON CONFLICT (campaign_recipient_id) DO NOTHING`,
    [params.campaignRecipientId, params.tenantId, params.campaignId]
  );
}

export async function recordEmailTrackingEvent(params: {
  tenantId: number;
  brandId?: number | null;
  campaignId: number;
  campaignRecipientId?: number | null;
  outboundMessageId?: number | null;
  contactId?: number | null;
  eventType: EmailTrackingEventType;
  eventKey: string;
  linkId?: number | null;
  fileId?: number | null;
  classification?: TrackingClassification | null;
  deviceClass?: string | null;
  meta?: Record<string, unknown>;
  conversionType?: string | null;
}): Promise<{ recorded: boolean; eventId?: number }> {
  try {
    const inserted = await query(
      `INSERT INTO email_tracking_events (
         tenant_id, brand_id, campaign_id, campaign_recipient_id, outbound_message_id,
         contact_id, event_type, event_key, link_id, file_id,
         classification, device_class, meta
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
       RETURNING id`,
      [
        params.tenantId,
        params.brandId || null,
        params.campaignId,
        params.campaignRecipientId || null,
        params.outboundMessageId || null,
        params.contactId || null,
        params.eventType,
        params.eventKey,
        params.linkId || null,
        params.fileId || null,
        params.classification || null,
        params.deviceClass || null,
        JSON.stringify(params.meta || {}),
      ]
    );
    if (params.campaignRecipientId) {
      await ensureEngagementRow({
        tenantId: params.tenantId,
        campaignId: params.campaignId,
        campaignRecipientId: params.campaignRecipientId,
      });
      await updateEngagementFromEvent({
        tenantId: params.tenantId,
        campaignId: params.campaignId,
        campaignRecipientId: params.campaignRecipientId,
        eventType: params.eventType,
        classification: params.classification,
        linkId: params.linkId,
        conversionType: params.conversionType,
      });
    }
    return { recorded: true, eventId: Number(inserted.rows[0].id) };
  } catch (err: any) {
    if (err.code === '23505') return { recorded: false };
    throw err;
  }
}

async function updateEngagementFromEvent(params: {
  tenantId: number;
  campaignId: number;
  campaignRecipientId?: number | null;
  eventType: EmailTrackingEventType;
  classification?: TrackingClassification | null;
  linkId?: number | null;
  conversionType?: string | null;
}) {
  const rid = params.campaignRecipientId;
  if (!rid) return;

  const now = 'CURRENT_TIMESTAMP';
  const type = params.eventType;

  if (type === 'QUEUED') {
    await query(
      `UPDATE email_recipient_engagement SET delivery_status = 'queued', queued_at = ${now}, updated_at = ${now}
       WHERE campaign_recipient_id = $1 AND tenant_id = $2`,
      [rid, params.tenantId]
    );
    return;
  }
  if (type === 'SEND_ATTEMPTED') {
    await query(
      `UPDATE email_recipient_engagement SET delivery_status = 'send_attempted', send_attempted_at = ${now}, updated_at = ${now}
       WHERE campaign_recipient_id = $1 AND tenant_id = $2`,
      [rid, params.tenantId]
    );
    return;
  }
  if (type === 'SMTP_ACCEPTED') {
    await query(
      `UPDATE email_recipient_engagement SET delivery_status = 'smtp_accepted', smtp_accepted_at = ${now}, updated_at = ${now}
       WHERE campaign_recipient_id = $1 AND tenant_id = $2`,
      [rid, params.tenantId]
    );
    return;
  }
  if (type === 'DELIVERED') {
    await query(
      `UPDATE email_recipient_engagement SET delivery_status = 'delivered', delivered_at = ${now}, updated_at = ${now}
       WHERE campaign_recipient_id = $1 AND tenant_id = $2`,
      [rid, params.tenantId]
    );
    return;
  }
  if (type === 'TEMP_DELIVERY_FAILURE') {
    await query(
      `UPDATE email_recipient_engagement SET delivery_status = 'temp_failure', temp_failure_at = ${now}, updated_at = ${now}
       WHERE campaign_recipient_id = $1 AND tenant_id = $2`,
      [rid, params.tenantId]
    );
    return;
  }
  if (type === 'PERM_DELIVERY_FAILURE') {
    await query(
      `UPDATE email_recipient_engagement SET delivery_status = 'perm_failure', perm_failure_at = ${now}, updated_at = ${now}
       WHERE campaign_recipient_id = $1 AND tenant_id = $2`,
      [rid, params.tenantId]
    );
    return;
  }
  if (type === 'OPEN_DETECTED') {
    const human = params.classification === 'human_probable';
    const prefetch = params.classification === 'prefetch_probable';
    await query(
      `UPDATE email_recipient_engagement SET
         first_open_at = COALESCE(first_open_at, CURRENT_TIMESTAMP),
         last_open_at = CURRENT_TIMESTAMP,
         open_count = open_count + 1,
         human_open_count = human_open_count + CASE WHEN $3 THEN 1 ELSE 0 END,
         prefetch_open_count = prefetch_open_count + CASE WHEN $4 THEN 1 ELSE 0 END,
         updated_at = CURRENT_TIMESTAMP
       WHERE campaign_recipient_id = $1 AND tenant_id = $2`,
      [rid, params.tenantId, human, prefetch]
    );
    return;
  }
  if (type === 'LINK_CLICKED') {
    const human = params.classification === 'human_probable';
    await query(
      `UPDATE email_recipient_engagement SET
         first_click_at = COALESCE(first_click_at, CURRENT_TIMESTAMP),
         last_click_at = CURRENT_TIMESTAMP,
         click_count = click_count + 1,
         human_click_count = human_click_count + CASE WHEN $3 THEN 1 ELSE 0 END,
         updated_at = CURRENT_TIMESTAMP
       WHERE campaign_recipient_id = $1 AND tenant_id = $2`,
      [rid, params.tenantId, human]
    );
    if (params.linkId) {
      await query(
        `INSERT INTO email_link_click_stats (link_id, tenant_id, campaign_id)
         VALUES ($1,$2,$3)
         ON CONFLICT (link_id) DO NOTHING`,
        [params.linkId, params.tenantId, params.campaignId]
      );
      await query(
        `UPDATE email_link_click_stats SET
           first_click_at = COALESCE(first_click_at, CURRENT_TIMESTAMP),
           last_click_at = CURRENT_TIMESTAMP,
           total_clicks = total_clicks + 1,
           human_clicks = human_clicks + CASE WHEN $4 THEN 1 ELSE 0 END,
           bot_clicks = bot_clicks + CASE WHEN $4 THEN 0 ELSE 1 END,
           updated_at = CURRENT_TIMESTAMP
         WHERE link_id = $1`,
        [params.linkId, params.tenantId, params.campaignId, human]
      );
    }
    return;
  }
  if (type === 'FILE_DOWNLOADED') {
    await query(
      `UPDATE email_recipient_engagement SET
         first_download_at = COALESCE(first_download_at, CURRENT_TIMESTAMP),
         last_download_at = CURRENT_TIMESTAMP,
         download_count = download_count + 1,
         updated_at = CURRENT_TIMESTAMP
       WHERE campaign_recipient_id = $1 AND tenant_id = $2`,
      [rid, params.tenantId]
    );
    return;
  }
  if (type === 'SITE_VISIT_VERIFIED') {
    await query(
      `UPDATE email_recipient_engagement SET
         first_site_visit_at = COALESCE(first_site_visit_at, CURRENT_TIMESTAMP),
         last_site_visit_at = CURRENT_TIMESTAMP,
         site_visit_count = site_visit_count + 1,
         updated_at = CURRENT_TIMESTAMP
       WHERE campaign_recipient_id = $1 AND tenant_id = $2`,
      [rid, params.tenantId]
    );
    return;
  }
  if (type === 'CONVERSION_COMPLETED') {
    await query(
      `UPDATE email_recipient_engagement SET
         conversion_at = COALESCE(conversion_at, CURRENT_TIMESTAMP),
         conversion_type = COALESCE(conversion_type, $3),
         updated_at = CURRENT_TIMESTAMP
       WHERE campaign_recipient_id = $1 AND tenant_id = $2`,
      [rid, params.tenantId, params.conversionType || 'conversion']
    );
    return;
  }
  if (type === 'UNSUBSCRIBED') {
    await query(
      `UPDATE email_recipient_engagement SET unsubscribed_at = ${now}, updated_at = ${now}
       WHERE campaign_recipient_id = $1 AND tenant_id = $2`,
      [rid, params.tenantId]
    );
    return;
  }
  if (type === 'SPAM_COMPLAINT') {
    await query(
      `UPDATE email_recipient_engagement SET complained_at = ${now}, updated_at = ${now}
       WHERE campaign_recipient_id = $1 AND tenant_id = $2`,
      [rid, params.tenantId]
    );
  }
}

export async function recordOpenEvent(params: {
  key: {
    tenant_id: number;
    brand_id: number | null;
    campaign_id: number;
    campaign_recipient_id: number;
    outbound_message_id: number | null;
    contact_id: number | null;
  };
  userAgent?: string | null;
  ip?: string | null;
}) {
  const { classification, deviceClass } = classifyTrackingRequest({
    userAgent: params.userAgent,
    purpose: 'open',
  });
  const bucket = Math.floor(Date.now() / 30000);
  return recordEmailTrackingEvent({
    tenantId: Number(params.key.tenant_id),
    brandId: params.key.brand_id,
    campaignId: Number(params.key.campaign_id),
    campaignRecipientId: Number(params.key.campaign_recipient_id),
    outboundMessageId: params.key.outbound_message_id,
    contactId: params.key.contact_id,
    eventType: 'OPEN_DETECTED',
    eventKey: buildEventKey(['open', params.key.campaign_recipient_id, bucket]),
    classification,
    deviceClass,
    meta: { ip_hash: hashIpForStorage(params.ip) },
  });
}

export async function recordClickEvent(params: {
  key: {
    tenant_id: number;
    brand_id: number | null;
    campaign_id: number;
    campaign_recipient_id: number;
    outbound_message_id: number | null;
    contact_id: number | null;
    purpose_ref_id: number | null;
  };
  userAgent?: string | null;
  ip?: string | null;
}) {
  const { classification, deviceClass } = classifyTrackingRequest({
    userAgent: params.userAgent,
    purpose: 'click',
  });
  const bucket = Math.floor(Date.now() / 10000);
  const linkId = params.key.purpose_ref_id;
  const result = await recordEmailTrackingEvent({
    tenantId: Number(params.key.tenant_id),
    brandId: params.key.brand_id,
    campaignId: Number(params.key.campaign_id),
    campaignRecipientId: Number(params.key.campaign_recipient_id),
    outboundMessageId: params.key.outbound_message_id,
    contactId: params.key.contact_id,
    eventType: 'LINK_CLICKED',
    eventKey: buildEventKey(['click', params.key.campaign_recipient_id, linkId, bucket]),
    linkId,
    classification,
    deviceClass,
    meta: { ip_hash: hashIpForStorage(params.ip) },
  });

  if (result.recorded && linkId) {
    await query(
      `UPDATE email_link_click_stats SET
         unique_recipients = (
           SELECT COUNT(DISTINCT campaign_recipient_id)::int
           FROM email_tracking_events
           WHERE link_id = $1 AND event_type = 'LINK_CLICKED'
             AND classification = 'human_probable'
         ),
         updated_at = CURRENT_TIMESTAMP
       WHERE link_id = $1`,
      [linkId]
    );
  }
  return result;
}

export async function recordDownloadEvent(params: {
  key: {
    tenant_id: number;
    brand_id: number | null;
    campaign_id: number;
    campaign_recipient_id: number;
    outbound_message_id: number | null;
    contact_id: number | null;
    purpose_ref_id: number | null;
  };
  userAgent?: string | null;
  ip?: string | null;
}) {
  const { classification, deviceClass } = classifyTrackingRequest({
    userAgent: params.userAgent,
    purpose: 'download',
  });
  const bucket = Math.floor(Date.now() / 60000);
  return recordEmailTrackingEvent({
    tenantId: Number(params.key.tenant_id),
    brandId: params.key.brand_id,
    campaignId: Number(params.key.campaign_id),
    campaignRecipientId: Number(params.key.campaign_recipient_id),
    outboundMessageId: params.key.outbound_message_id,
    contactId: params.key.contact_id,
    eventType: 'FILE_DOWNLOADED',
    eventKey: buildEventKey(['download', params.key.campaign_recipient_id, params.key.purpose_ref_id, bucket]),
    fileId: params.key.purpose_ref_id,
    classification,
    deviceClass,
    meta: { ip_hash: hashIpForStorage(params.ip) },
  });
}

export async function recordDeliveryLifecycleEvent(params: {
  tenantId: number;
  brandId?: number | null;
  campaignId: number;
  campaignRecipientId: number;
  outboundMessageId?: number | null;
  contactId?: number | null;
  eventType: Extract<
    EmailTrackingEventType,
    | 'QUEUED'
    | 'SEND_ATTEMPTED'
    | 'SMTP_ACCEPTED'
    | 'DELIVERED'
    | 'TEMP_DELIVERY_FAILURE'
    | 'PERM_DELIVERY_FAILURE'
  >;
  dedupeSuffix?: string;
  meta?: Record<string, unknown>;
}) {
  return recordEmailTrackingEvent({
    tenantId: params.tenantId,
    brandId: params.brandId,
    campaignId: params.campaignId,
    campaignRecipientId: params.campaignRecipientId,
    outboundMessageId: params.outboundMessageId,
    contactId: params.contactId,
    eventType: params.eventType,
    eventKey: buildEventKey([
      params.eventType,
      params.campaignRecipientId,
      params.outboundMessageId,
      params.dedupeSuffix,
    ]),
    meta: params.meta,
  });
}

export async function recordUnsubscribedTracking(params: {
  tenantId: number;
  campaignId: number;
  campaignRecipientId: number;
  contactId?: number | null;
}) {
  return recordEmailTrackingEvent({
    tenantId: params.tenantId,
    campaignId: params.campaignId,
    campaignRecipientId: params.campaignRecipientId,
    contactId: params.contactId || null,
    eventType: 'UNSUBSCRIBED',
    eventKey: buildEventKey(['unsub', params.campaignRecipientId]),
  });
}

export async function recordSiteEvent(params: {
  tokenKey: {
    tenant_id: number;
    brand_id: number | null;
    campaign_id: number;
    campaign_recipient_id: number;
    contact_id: number | null;
  };
  eventName: string;
  dedupeId?: string;
}) {
  const normalized = String(params.eventName || '').trim().toLowerCase();
  const isConversion = ['demo_submitted', 'purchase_completed', 'conversion', 'demo_form_opened'].includes(
    normalized
  );
  const isPageView = normalized === 'page_viewed' || normalized === 'page_view';

  const eventType: EmailTrackingEventType = isConversion
    ? normalized === 'demo_form_opened'
      ? 'SITE_VISIT_VERIFIED'
      : 'CONVERSION_COMPLETED'
    : isPageView
      ? 'SITE_VISIT_VERIFIED'
      : 'CONVERSION_COMPLETED';

  const dedupe = params.dedupeId || crypto.randomBytes(8).toString('hex');
  return recordEmailTrackingEvent({
    tenantId: Number(params.tokenKey.tenant_id),
    brandId: params.tokenKey.brand_id,
    campaignId: Number(params.tokenKey.campaign_id),
    campaignRecipientId: Number(params.tokenKey.campaign_recipient_id),
    contactId: params.tokenKey.contact_id,
    eventType,
    eventKey: buildEventKey(['site', params.tokenKey.campaign_recipient_id, normalized, dedupe]),
    conversionType: isConversion ? normalized : undefined,
    meta: { event_name: normalized },
  });
}
