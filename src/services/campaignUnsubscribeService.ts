import crypto from 'crypto';
import { query } from '../config/database';
import { normalizeEmailAddress, upsertSuppression } from './suppressionService';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function maskEmail(email: string): string {
  const [local, domain] = normalizeEmailAddress(email).split('@');
  if (!local || !domain) return 'e-posta adresiniz';
  const visible = local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(2, local.length - 2))}@${domain}`;
}

export async function getOrCreateUnsubscribeUrl(params: {
  tenantId: number;
  campaignId: number;
  recipientId: number;
  email: string;
}) {
  const existing = await query(
    `SELECT token_hash FROM campaign_unsubscribe_tokens
     WHERE tenant_id = $1 AND campaign_recipient_id = $2`,
    [params.tenantId, params.recipientId]
  );
  if (existing.rows.length > 0) {
    // Existing records only store the hash. A new raw token cannot be reconstructed,
    // so create a fresh token and rotate before rendering.
    await query(
      `DELETE FROM campaign_unsubscribe_tokens
       WHERE tenant_id = $1 AND campaign_recipient_id = $2`,
      [params.tenantId, params.recipientId]
    );
  }

  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO campaign_unsubscribe_tokens (
       tenant_id, campaign_id, campaign_recipient_id, email_normalized, token_hash, expires_at
     ) VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP + INTERVAL '2 years')`,
    [
      params.tenantId,
      params.campaignId,
      params.recipientId,
      normalizeEmailAddress(params.email),
      hashToken(token),
    ]
  );

  const base = process.env.FRONTEND_URL || 'https://example.com';
  return `${base.replace(/\/$/, '')}/unsubscribe/${token}`;
}

export async function unsubscribeByToken(params: {
  token: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  const tokenHash = hashToken(params.token);
  const found = await query(
    `SELECT ut.*, cr.email
     FROM campaign_unsubscribe_tokens ut
     JOIN campaign_recipients cr
       ON cr.id = ut.campaign_recipient_id
      AND cr.tenant_id = ut.tenant_id
     WHERE ut.token_hash = $1
       AND (ut.expires_at IS NULL OR ut.expires_at > CURRENT_TIMESTAMP)
     LIMIT 1`,
    [tokenHash]
  );

  const row = found.rows[0];
  if (!row) {
    return { ok: false as const, status: 404, message: 'Abonelikten çıkma bağlantısı geçersiz veya süresi dolmuş.' };
  }

  const suppression = await upsertSuppression({
    tenantId: Number(row.tenant_id),
    email: row.email,
    reason: 'UNSUBSCRIBED',
    source: 'unsubscribe_link',
    campaignId: Number(row.campaign_id),
  });

  await query(
    `UPDATE campaign_unsubscribe_tokens
     SET used_at = COALESCE(used_at, CURRENT_TIMESTAMP)
     WHERE id = $1`,
    [row.id]
  );

  const ipHash = params.ip
    ? crypto.createHash('sha256').update(params.ip).digest('hex')
    : null;

  await query(
    `INSERT INTO campaign_unsubscribe_events (
       tenant_id, campaign_id, campaign_recipient_id, email_normalized,
       suppression_id, ip_hash, user_agent
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      row.tenant_id,
      row.campaign_id,
      row.campaign_recipient_id,
      row.email_normalized,
      suppression.id,
      ipHash,
      params.userAgent ? String(params.userAgent).slice(0, 500) : null,
    ]
  );

  return {
    ok: true as const,
    maskedEmail: maskEmail(row.email),
    message: 'Abonelikten çıkma tercihiniz kaydedildi.',
  };
}
