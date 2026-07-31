import { query } from '../config/database';
import { notFound } from './channelPlatform';
import { Response } from 'express';

export type ResolvedSenderIdentity = {
  sender_identity_id: number;
  display_name: string;
  sender_value: string;
  reply_to: string | null;
  brand_id: number;
  brand_name: string;
  channel_connection_id: number;
  mail_account_id: number;
  mail_account_email: string;
  mail_account_name: string;
};

export type ResolvedSmsSenderIdentity = {
  sender_identity_id: number;
  display_name: string;
  sender_value: string;
  brand_id: number;
  brand_name: string;
  channel_connection_id: number;
  provider: string;
  connection_status: string;
  encrypted_credentials: string;
  settings: Record<string, unknown>;
};

export type ResolvedWhatsAppSenderIdentity = ResolvedSmsSenderIdentity;

/**
 * Resolve a sender identity that is safe to send EMAIL with.
 * Returns null for not-found (cross-tenant / missing) so callers can 404.
 * Throws with code SENDER_NOT_ELIGIBLE for same-tenant but ineligible senders.
 */
export async function resolveEligibleSenderIdentity(
  senderIdentityId: number,
  tenantId: number
): Promise<ResolvedSenderIdentity | null> {
  const result = await query(
    `SELECT
       si.id AS sender_identity_id,
       si.display_name,
       si.sender_value,
       si.reply_to,
       si.is_active AS sender_active,
       si.is_verified AS sender_verified,
       si.channel_type,
       si.brand_id,
       b.name AS brand_name,
       cc.id AS channel_connection_id,
       cc.status AS connection_status,
       cc.mail_account_id,
       ma.email AS mail_account_email,
       ma.name AS mail_account_name,
       ma.is_active AS mail_account_active,
       ma.tenant_id AS mail_account_tenant_id
     FROM sender_identities si
     JOIN brands b ON b.id = si.brand_id AND b.tenant_id = si.tenant_id
     JOIN channel_connections cc
       ON cc.id = si.channel_connection_id AND cc.tenant_id = si.tenant_id
     LEFT JOIN mail_accounts ma
       ON ma.id = cc.mail_account_id AND ma.tenant_id = si.tenant_id
     WHERE si.id = $1 AND si.tenant_id = $2`,
    [senderIdentityId, tenantId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];

  if (row.channel_type !== 'EMAIL') {
    throw Object.assign(new Error('Sender identity is not an EMAIL channel'), {
      code: 'SENDER_NOT_ELIGIBLE',
    });
  }
  if (!row.sender_active) {
    throw Object.assign(new Error('Sender identity is inactive'), {
      code: 'SENDER_NOT_ELIGIBLE',
    });
  }
  if (!row.sender_verified) {
    throw Object.assign(new Error('Sender identity is not verified'), {
      code: 'SENDER_NOT_ELIGIBLE',
    });
  }
  if (row.connection_status !== 'ACTIVE') {
    throw Object.assign(new Error('Channel connection is not active'), {
      code: 'SENDER_NOT_ELIGIBLE',
    });
  }
  if (!row.mail_account_id || row.mail_account_tenant_id !== tenantId) {
    throw Object.assign(new Error('Sender identity is not linked to a mail account'), {
      code: 'SENDER_NOT_ELIGIBLE',
    });
  }
  if (!row.mail_account_active) {
    throw Object.assign(new Error('Mail account is inactive'), {
      code: 'SENDER_NOT_ELIGIBLE',
    });
  }

  const senderEmail = String(row.sender_value || '').trim().toLowerCase();
  const accountEmail = String(row.mail_account_email || '').trim().toLowerCase();
  if (!senderEmail || senderEmail !== accountEmail) {
    throw Object.assign(new Error('Sender value does not match mail account email'), {
      code: 'SENDER_NOT_ELIGIBLE',
    });
  }

  return {
    sender_identity_id: row.sender_identity_id,
    display_name: row.display_name,
    sender_value: row.sender_value,
    reply_to: row.reply_to,
    brand_id: row.brand_id,
    brand_name: row.brand_name,
    channel_connection_id: row.channel_connection_id,
    mail_account_id: row.mail_account_id,
    mail_account_email: row.mail_account_email,
    mail_account_name: row.mail_account_name,
  };
}

/**
 * Resolve SMS sender identity: active, verified, ACTIVE connection, credentials present.
 */
export async function resolveEligibleSmsSenderIdentity(
  senderIdentityId: number,
  tenantId: number,
  brandId?: number | null
): Promise<ResolvedSmsSenderIdentity | null> {
  const result = await query(
    `SELECT
       si.id AS sender_identity_id,
       si.display_name,
       si.sender_value,
       si.is_active AS sender_active,
       si.is_verified AS sender_verified,
       si.channel_type,
       si.brand_id,
       b.name AS brand_name,
       cc.id AS channel_connection_id,
       cc.status AS connection_status,
       cc.provider,
       cc.encrypted_credentials,
       cc.settings
     FROM sender_identities si
     JOIN brands b ON b.id = si.brand_id AND b.tenant_id = si.tenant_id
     JOIN channel_connections cc
       ON cc.id = si.channel_connection_id AND cc.tenant_id = si.tenant_id
     WHERE si.id = $1 AND si.tenant_id = $2`,
    [senderIdentityId, tenantId]
  );

  if (result.rows.length === 0) return null;
  const row = result.rows[0];

  if (brandId != null && Number(row.brand_id) !== Number(brandId)) {
    throw Object.assign(new Error('Gönderici kimliği marka ile uyuşmuyor'), {
      code: 'SENDER_NOT_ELIGIBLE',
    });
  }
  if (row.channel_type !== 'SMS') {
    throw Object.assign(new Error('Sender identity is not an SMS channel'), {
      code: 'SENDER_NOT_ELIGIBLE',
    });
  }
  if (!row.sender_active) {
    throw Object.assign(new Error('Sender identity is inactive'), {
      code: 'SENDER_NOT_ELIGIBLE',
    });
  }
  if (!row.sender_verified) {
    throw Object.assign(new Error('Sender identity is not verified'), {
      code: 'SENDER_NOT_ELIGIBLE',
    });
  }
  if (row.connection_status !== 'ACTIVE') {
    throw Object.assign(new Error('Channel connection is not active'), {
      code: 'SENDER_NOT_ELIGIBLE',
    });
  }
  if (!row.encrypted_credentials) {
    throw Object.assign(new Error('SMS credentials missing'), {
      code: 'SENDER_NOT_ELIGIBLE',
    });
  }
  if (!String(row.sender_value || '').trim()) {
    throw Object.assign(new Error('SMS sender header missing'), {
      code: 'SENDER_NOT_ELIGIBLE',
    });
  }

  return {
    sender_identity_id: row.sender_identity_id,
    display_name: row.display_name,
    sender_value: String(row.sender_value).trim(),
    brand_id: row.brand_id,
    brand_name: row.brand_name,
    channel_connection_id: row.channel_connection_id,
    provider: String(row.provider || '').toUpperCase(),
    connection_status: row.connection_status,
    encrypted_credentials: row.encrypted_credentials,
    settings: row.settings || {},
  };
}

/**
 * Resolve WhatsApp sender identity: active, verified, ACTIVE connection, credentials present.
 */
export async function resolveEligibleWhatsAppSenderIdentity(
  senderIdentityId: number,
  tenantId: number,
  brandId?: number | null
): Promise<ResolvedWhatsAppSenderIdentity | null> {
  const result = await query(
    `SELECT
       si.id AS sender_identity_id,
       si.display_name,
       si.sender_value,
       si.is_active AS sender_active,
       si.is_verified AS sender_verified,
       si.channel_type,
       si.brand_id,
       b.name AS brand_name,
       cc.id AS channel_connection_id,
       cc.status AS connection_status,
       cc.provider,
       cc.encrypted_credentials,
       cc.settings
     FROM sender_identities si
     JOIN brands b ON b.id = si.brand_id AND b.tenant_id = si.tenant_id
     JOIN channel_connections cc
       ON cc.id = si.channel_connection_id AND cc.tenant_id = si.tenant_id
     WHERE si.id = $1 AND si.tenant_id = $2`,
    [senderIdentityId, tenantId]
  );

  if (result.rows.length === 0) return null;
  const row = result.rows[0];

  if (brandId != null && Number(row.brand_id) !== Number(brandId)) {
    throw Object.assign(new Error('Gönderici kimliği marka ile uyuşmuyor'), {
      code: 'SENDER_NOT_ELIGIBLE',
    });
  }
  if (row.channel_type !== 'WHATSAPP') {
    throw Object.assign(new Error('Sender identity is not a WHATSAPP channel'), {
      code: 'SENDER_NOT_ELIGIBLE',
    });
  }
  if (!row.sender_active) {
    throw Object.assign(new Error('Sender identity is inactive'), {
      code: 'SENDER_NOT_ELIGIBLE',
    });
  }
  if (!row.sender_verified) {
    throw Object.assign(new Error('Sender identity is not verified'), {
      code: 'SENDER_NOT_ELIGIBLE',
    });
  }
  if (row.connection_status !== 'ACTIVE') {
    throw Object.assign(new Error('Channel connection is not active'), {
      code: 'SENDER_NOT_ELIGIBLE',
    });
  }
  if (!row.encrypted_credentials) {
    throw Object.assign(new Error('WhatsApp credentials missing'), {
      code: 'SENDER_NOT_ELIGIBLE',
    });
  }
  if (!String(row.sender_value || '').trim()) {
    throw Object.assign(new Error('WhatsApp sender value missing'), {
      code: 'SENDER_NOT_ELIGIBLE',
    });
  }

  return {
    sender_identity_id: row.sender_identity_id,
    display_name: row.display_name,
    sender_value: String(row.sender_value).trim(),
    brand_id: row.brand_id,
    brand_name: row.brand_name,
    channel_connection_id: row.channel_connection_id,
    provider: String(row.provider || '').toUpperCase(),
    connection_status: row.connection_status,
    encrypted_credentials: row.encrypted_credentials,
    settings: row.settings || {},
  };
}

/**
 * Ensure an active/verified WhatsApp sender_identity exists for an ACTIVE connection.
 * Used by compose when channel is selected but SI was never created (best-effort signup gap).
 */
export async function ensureWhatsAppSenderForConnection(
  connectionId: number,
  tenantId: number
): Promise<{
  sender_identity_id: number;
  channel_connection_id: number;
  brand_id: number;
  display_name: string;
  sender_value: string;
  business_phone: string | null;
  phone_number_id: string | null;
  created: boolean;
} | null> {
  const conn = await query(
    `SELECT cc.id, cc.brand_id, cc.channel_type, cc.status, cc.display_name, cc.settings,
            cc.encrypted_credentials
     FROM channel_connections cc
     WHERE cc.id = $1 AND cc.tenant_id = $2`,
    [connectionId, tenantId]
  );
  if (!conn.rows[0]) return null;
  const row = conn.rows[0];
  if (row.channel_type !== 'WHATSAPP') {
    throw Object.assign(new Error('Kanal WhatsApp değil'), { code: 'SENDER_NOT_ELIGIBLE' });
  }
  if (row.status !== 'ACTIVE') {
    throw Object.assign(new Error('WhatsApp kanalı aktif değil'), { code: 'SENDER_NOT_ELIGIBLE' });
  }
  if (!row.encrypted_credentials) {
    throw Object.assign(new Error('WhatsApp kimlik bilgileri eksik'), { code: 'SENDER_NOT_ELIGIBLE' });
  }

  const settings =
    row.settings && typeof row.settings === 'object' && !Array.isArray(row.settings)
      ? row.settings
      : {};
  const businessPhone = String(
    settings.business_phone_number || settings.business_phone || ''
  ).trim();
  const phoneNumberId = String(settings.phone_number_id || '').trim() || null;
  const verifiedName = String(settings.verified_name || '').trim();
  const displayName =
    verifiedName || String(row.display_name || '').trim() || businessPhone || 'WhatsApp';
  const senderValue = businessPhone || phoneNumberId || displayName;

  const existing = await query(
    `SELECT id, display_name, sender_value
     FROM sender_identities
     WHERE tenant_id = $1 AND channel_connection_id = $2 AND channel_type = 'WHATSAPP'
     ORDER BY id ASC
     LIMIT 1`,
    [tenantId, connectionId]
  );

  if (existing.rows[0]) {
    // Reactivate / verify if needed so compose can send
    await query(
      `UPDATE sender_identities
       SET is_active = true,
           is_verified = true,
           display_name = COALESCE(NULLIF(display_name, ''), $2),
           sender_value = COALESCE(NULLIF(sender_value, ''), $3),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND tenant_id = $4`,
      [existing.rows[0].id, displayName, senderValue, tenantId]
    );
    return {
      sender_identity_id: existing.rows[0].id,
      channel_connection_id: connectionId,
      brand_id: row.brand_id,
      display_name: displayName,
      sender_value: senderValue,
      business_phone: businessPhone || null,
      phone_number_id: phoneNumberId,
      created: false,
    };
  }

  const inserted = await query(
    `INSERT INTO sender_identities
       (tenant_id, brand_id, channel_connection_id, channel_type, display_name, sender_value,
        is_default, is_active, is_verified)
     VALUES ($1,$2,$3,'WHATSAPP',$4,$5,true,true,true)
     RETURNING id`,
    [tenantId, row.brand_id, connectionId, displayName, senderValue]
  );

  return {
    sender_identity_id: inserted.rows[0].id,
    channel_connection_id: connectionId,
    brand_id: row.brand_id,
    display_name: displayName,
    sender_value: senderValue,
    business_phone: businessPhone || null,
    phone_number_id: phoneNumberId,
    created: true,
  };
}

export function respondSenderResolveError(res: Response, error: any) {
  if (error?.code === 'SENDER_NOT_ELIGIBLE') {
    return res.status(400).json({
      success: false,
      error: 'Gönderici kimliği gönderim için uygun değil',
    });
  }
  return notFound(res);
}
