import crypto from 'crypto';
import { query } from '../config/database';

export type TrackingPurpose = 'OPEN' | 'CLICK' | 'DOWNLOAD' | 'SITE';

export function hashTrackingToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function getTrackingBaseUrl(): string {
  const base = (
    process.env.PUBLIC_BACKEND_URL ||
    process.env.BACKEND_URL ||
    process.env.TRACKING_BASE_URL ||
    `http://localhost:${process.env.PORT || 5000}`
  )
    .trim()
    .replace(/\/+$/, '');
  return base;
}

export function generateRawTrackingToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export async function getOrCreateTrackingKey(params: {
  tenantId: number;
  campaignId: number;
  campaignRecipientId: number;
  outboundMessageId?: number | null;
  purpose: TrackingPurpose;
  purposeRefId?: number | null;
  expiresInDays?: number;
}): Promise<{ token: string; keyId: number }> {
  const purposeRefId = params.purposeRefId ?? null;
  const existing = await query(
    `SELECT id, token_hash FROM email_tracking_keys
     WHERE campaign_recipient_id = $1 AND purpose = $2
       AND COALESCE(purpose_ref_id, 0) = COALESCE($3::int, 0)`,
    [params.campaignRecipientId, params.purpose, purposeRefId]
  );

  if (existing.rows.length > 0) {
    const token = generateRawTrackingToken();
    const tokenHash = hashTrackingToken(token);
    await query(
      `UPDATE email_tracking_keys
       SET token_hash = $2,
           outbound_message_id = COALESCE($3, outbound_message_id),
           expires_at = CURRENT_TIMESTAMP + ($4::text || ' days')::interval
       WHERE id = $1`,
      [
        existing.rows[0].id,
        tokenHash,
        params.outboundMessageId || null,
        String(params.expiresInDays ?? 180),
      ]
    );
    return { token, keyId: Number(existing.rows[0].id) };
  }

  const token = generateRawTrackingToken();
  const tokenHash = hashTrackingToken(token);
  const inserted = await query(
    `INSERT INTO email_tracking_keys (
       tenant_id, campaign_id, campaign_recipient_id, outbound_message_id,
       purpose, purpose_ref_id, token_hash, expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7, CURRENT_TIMESTAMP + ($8::text || ' days')::interval)
     RETURNING id`,
    [
      params.tenantId,
      params.campaignId,
      params.campaignRecipientId,
      params.outboundMessageId || null,
      params.purpose,
      purposeRefId,
      tokenHash,
      String(params.expiresInDays ?? 180),
    ]
  );
  return { token, keyId: Number(inserted.rows[0].id) };
}

export type ResolvedTrackingKey = {
  id: number;
  tenant_id: number;
  campaign_id: number;
  campaign_recipient_id: number;
  outbound_message_id: number | null;
  purpose: TrackingPurpose;
  purpose_ref_id: number | null;
  contact_id: number | null;
  brand_id: number | null;
};

export async function resolveTrackingToken(
  token: string
): Promise<ResolvedTrackingKey | null> {
  const tokenHash = hashTrackingToken(token);
  const res = await query(
    `SELECT k.*, cr.contact_id, c.brand_id
     FROM email_tracking_keys k
     JOIN campaign_recipients cr ON cr.id = k.campaign_recipient_id AND cr.tenant_id = k.tenant_id
     JOIN campaigns c ON c.id = k.campaign_id AND c.tenant_id = k.tenant_id
     WHERE k.token_hash = $1
       AND (k.expires_at IS NULL OR k.expires_at > CURRENT_TIMESTAMP)`,
    [tokenHash]
  );
  return res.rows[0] || null;
}

export function buildOpenPixelUrl(token: string): string {
  return `${getTrackingBaseUrl()}/t/o/${encodeURIComponent(token)}`;
}

export function buildClickRedirectUrl(token: string): string {
  return `${getTrackingBaseUrl()}/t/c/${encodeURIComponent(token)}`;
}

export function buildDownloadUrl(token: string): string {
  return `${getTrackingBaseUrl()}/t/d/${encodeURIComponent(token)}`;
}

/** 1x1 transparent GIF */
export const TRACKING_PIXEL_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);
