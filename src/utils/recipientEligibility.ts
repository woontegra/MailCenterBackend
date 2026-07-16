import { query } from '../config/database';
import { normalizeEmail, normalizePhone, getTenantDefaultCountryCode } from './contactNormalize';

export type PreferenceStatus = 'UNKNOWN' | 'OPTED_IN' | 'OPTED_OUT' | 'BLOCKED';
export type ChannelType = 'EMAIL' | 'SMS' | 'WHATSAPP';

export type EligibilityResult = {
  eligible: boolean;
  reason?: string;
  code?: string;
  contactId?: number | null;
  preferenceStatus?: PreferenceStatus | null;
  normalizedValue?: string | null;
};

async function findPreference(params: {
  tenantId: number;
  contactId: number;
  channelType: ChannelType;
  brandId?: number | null;
}): Promise<PreferenceStatus> {
  if (params.brandId) {
    const brandPref = await query(
      `SELECT status FROM communication_preferences
       WHERE tenant_id = $1 AND contact_id = $2 AND channel_type = $3 AND brand_id = $4`,
      [params.tenantId, params.contactId, params.channelType, params.brandId]
    );
    if (brandPref.rows[0]) return brandPref.rows[0].status as PreferenceStatus;
  }

  const globalPref = await query(
    `SELECT status FROM communication_preferences
     WHERE tenant_id = $1 AND contact_id = $2 AND channel_type = $3 AND brand_id IS NULL`,
    [params.tenantId, params.contactId, params.channelType]
  );
  return (globalPref.rows[0]?.status as PreferenceStatus) || 'UNKNOWN';
}

async function findContactPoint(params: {
  tenantId: number;
  channelType: ChannelType;
  normalizedValue: string;
}) {
  const result = await query(
    `SELECT cp.*, c.status AS contact_status
     FROM contact_points cp
     JOIN contacts c ON c.id = cp.contact_id AND c.tenant_id = cp.tenant_id
     WHERE cp.tenant_id = $1
       AND cp.channel_type = $2
       AND cp.normalized_value = $3
       AND cp.is_active = true
     LIMIT 1`,
    [params.tenantId, params.channelType, params.normalizedValue]
  );
  return result.rows[0] || null;
}

/**
 * Shared recipient eligibility.
 * - EMAIL compose: pass strictPreference=false → only BLOCKED blocks (preserves 1:1 compose).
 * - SMS/WhatsApp (and future workers): strictPreference=true → OPTED_IN required; UNKNOWN not eligible.
 */
export async function checkRecipientEligibility(params: {
  tenantId: number;
  channelType: ChannelType;
  value: string;
  brandId?: number | null;
  countryCode?: string | null;
  /** When true, UNKNOWN/OPTED_OUT are not eligible. Default: true for SMS/WhatsApp, false for EMAIL. */
  strictPreference?: boolean;
}): Promise<EligibilityResult> {
  const strict =
    params.strictPreference !== undefined
      ? params.strictPreference
      : params.channelType !== 'EMAIL';

  let normalized: string;

  if (params.channelType === 'EMAIL') {
    const email = normalizeEmail(params.value);
    if (email.ok === false) {
      return { eligible: false, code: 'INVALID_ADDRESS', reason: email.error };
    }
    normalized = email.normalized;
  } else {
    const cc = params.countryCode || (await getTenantDefaultCountryCode(params.tenantId));
    const phone = normalizePhone({ value: params.value, countryCode: cc });
    if (phone.ok === false) {
      return { eligible: false, code: 'INVALID_ADDRESS', reason: phone.error };
    }
    normalized = phone.normalized;
  }

  const point = await findContactPoint({
    tenantId: params.tenantId,
    channelType: params.channelType,
    normalizedValue: normalized,
  });

  if (!point) {
    if (!strict || params.channelType === 'EMAIL') {
      return {
        eligible: true,
        preferenceStatus: 'UNKNOWN',
        normalizedValue: normalized,
        contactId: null,
      };
    }
    return {
      eligible: false,
      code: 'UNKNOWN_PREFERENCE',
      reason: 'SMS/WhatsApp için kişi kaydı ve açık izin gerekli',
      preferenceStatus: 'UNKNOWN',
      normalizedValue: normalized,
      contactId: null,
    };
  }

  if (point.contact_status === 'BLOCKED') {
    return {
      eligible: false,
      code: 'CONTACT_BLOCKED',
      reason: 'Kişi engellenmiş',
      contactId: point.contact_id,
      preferenceStatus: 'BLOCKED',
      normalizedValue: normalized,
    };
  }

  const preference = await findPreference({
    tenantId: params.tenantId,
    contactId: point.contact_id,
    channelType: params.channelType,
    brandId: params.brandId,
  });

  if (preference === 'BLOCKED') {
    return {
      eligible: false,
      code: 'BLOCKED',
      reason: 'Bu kanal için gönderim engellenmiş',
      contactId: point.contact_id,
      preferenceStatus: preference,
      normalizedValue: normalized,
    };
  }

  if (!strict) {
    return {
      eligible: true,
      contactId: point.contact_id,
      preferenceStatus: preference,
      normalizedValue: normalized,
    };
  }

  if (preference === 'OPTED_OUT') {
    return {
      eligible: false,
      code: 'OPTED_OUT',
      reason: 'Bu kanal için izin verilmemiş (OPTED_OUT)',
      contactId: point.contact_id,
      preferenceStatus: preference,
      normalizedValue: normalized,
    };
  }

  if (preference === 'UNKNOWN') {
    return {
      eligible: false,
      code: 'UNKNOWN_PREFERENCE',
      reason: 'SMS/WhatsApp için UNKNOWN izin durumu gönderime uygun değil',
      contactId: point.contact_id,
      preferenceStatus: preference,
      normalizedValue: normalized,
    };
  }

  if (preference !== 'OPTED_IN') {
    return {
      eligible: false,
      code: 'NOT_OPTED_IN',
      reason: 'SMS/WhatsApp için OPTED_IN gerekli',
      contactId: point.contact_id,
      preferenceStatus: preference,
      normalizedValue: normalized,
    };
  }

  return {
    eligible: true,
    contactId: point.contact_id,
    preferenceStatus: preference,
    normalizedValue: normalized,
  };
}

/** Check EMAIL recipients for BLOCKED only (compose / outbound worker). */
export async function assertEmailNotBlocked(params: {
  tenantId: number;
  addresses: string[];
  brandId?: number | null;
}): Promise<{ ok: true } | { ok: false; reason: string; address: string }> {
  for (const address of params.addresses) {
    const result = await checkRecipientEligibility({
      tenantId: params.tenantId,
      channelType: 'EMAIL',
      value: address,
      brandId: params.brandId,
      strictPreference: false,
    });
    if (!result.eligible && (result.code === 'BLOCKED' || result.code === 'CONTACT_BLOCKED')) {
      return {
        ok: false,
        reason: result.reason || 'Bu e-posta adresine gönderim engellenmiş',
        address,
      };
    }
  }
  return { ok: true };
}

/** Future inbound/outbound matching helper — match recipient to contact points. */
export async function findContactsByNormalizedRecipient(params: {
  tenantId: number;
  channelType: ChannelType;
  rawValue: string;
}) {
  let normalized: string | null = null;
  if (params.channelType === 'EMAIL') {
    const email = normalizeEmail(params.rawValue);
    if (email.ok) normalized = email.normalized;
  } else {
    const phone = normalizePhone({ value: params.rawValue, countryCode: null });
    if (phone.ok) normalized = phone.normalized;
    else {
      const cc = await getTenantDefaultCountryCode(params.tenantId);
      const again = normalizePhone({ value: params.rawValue, countryCode: cc });
      if (again.ok) normalized = again.normalized;
    }
  }
  if (!normalized) return [];

  const result = await query(
    `SELECT c.id, c.first_name, c.last_name, c.company_name, cp.id AS contact_point_id, cp.normalized_value
     FROM contact_points cp
     JOIN contacts c ON c.id = cp.contact_id AND c.tenant_id = cp.tenant_id
     WHERE cp.tenant_id = $1
       AND cp.channel_type = $2
       AND cp.normalized_value = $3
       AND cp.is_active = true
       AND c.status = 'ACTIVE'`,
    [params.tenantId, params.channelType, normalized]
  );
  return result.rows;
}
