import { query } from '../config/database';

export type SuppressionReason =
  | 'UNSUBSCRIBED'
  | 'BOUNCE_PERMANENT'
  | 'SPAM_COMPLAINT'
  | 'ADMIN_BLOCKED'
  | 'INVALID_ADDRESS';

export function normalizeEmailAddress(email: string): string {
  return String(email || '').trim().toLowerCase();
}

export function isValidEmailAddress(email: string): boolean {
  const value = normalizeEmailAddress(email);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export async function listSuppressions(params: {
  tenantId: number;
  q?: string;
  reason?: string;
  limit?: number;
  offset?: number;
}) {
  const values: unknown[] = [params.tenantId];
  let sql = `
    SELECT id, email, reason, source, campaign_id, created_at
    FROM email_suppressions
    WHERE tenant_id = $1
  `;
  if (params.reason) {
    values.push(params.reason);
    sql += ` AND reason = $${values.length}`;
  }
  if (params.q?.trim()) {
    values.push(`%${normalizeEmailAddress(params.q)}%`);
    sql += ` AND email_normalized ILIKE $${values.length}`;
  }
  values.push(Math.min(200, params.limit || 100));
  sql += ` ORDER BY created_at DESC LIMIT $${values.length}`;
  values.push(params.offset || 0);
  sql += ` OFFSET $${values.length}`;

  const result = await query(sql, values);
  return result.rows;
}

export async function upsertSuppression(params: {
  tenantId: number;
  email: string;
  reason: SuppressionReason;
  source?: string;
  campaignId?: number | null;
  createdBy?: number | null;
}) {
  const email = String(params.email || '').trim();
  const normalized = normalizeEmailAddress(email);
  if (!isValidEmailAddress(normalized)) {
    throw Object.assign(new Error('Geçersiz e-posta'), { status: 400 });
  }

  const result = await query(
    `INSERT INTO email_suppressions (
       tenant_id, email, email_normalized, reason, source, campaign_id, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_id, email_normalized)
     DO UPDATE SET
       reason = EXCLUDED.reason,
       source = EXCLUDED.source,
       campaign_id = COALESCE(EXCLUDED.campaign_id, email_suppressions.campaign_id),
       created_by = COALESCE(EXCLUDED.created_by, email_suppressions.created_by)
     RETURNING id, email, reason, source, campaign_id, created_at`,
    [
      params.tenantId,
      email,
      normalized,
      params.reason,
      params.source || 'manual',
      params.campaignId || null,
      params.createdBy || null,
    ]
  );
  return result.rows[0];
}

export async function removeSuppression(tenantId: number, id: number) {
  const result = await query(
    `DELETE FROM email_suppressions WHERE id = $1 AND tenant_id = $2 RETURNING id`,
    [id, tenantId]
  );
  return result.rows[0] || null;
}

export async function findSuppressedEmails(
  tenantId: number,
  emails: string[]
): Promise<Map<string, { reason: string; id: number }>> {
  const normalized = Array.from(new Set(emails.map(normalizeEmailAddress).filter(Boolean)));
  if (normalized.length === 0) return new Map();

  const result = await query(
    `SELECT id, email_normalized, reason
     FROM email_suppressions
     WHERE tenant_id = $1 AND email_normalized = ANY($2::text[])`,
    [tenantId, normalized]
  );

  const map = new Map<string, { reason: string; id: number }>();
  for (const row of result.rows) {
    map.set(row.email_normalized, { reason: row.reason, id: Number(row.id) });
  }
  return map;
}
