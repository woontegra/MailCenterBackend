import { query } from '../config/database';

const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export function normalizeEmail(value: string): { ok: true; value: string; normalized: string } | { ok: false; error: string } {
  const raw = String(value || '').trim();
  if (!raw) return { ok: false, error: 'E-posta adresi gerekli' };
  const normalized = raw.toLowerCase();
  if (!EMAIL_RE.test(normalized)) return { ok: false, error: 'E-posta adresi geçersiz.' };
  if (normalized.length > 320) return { ok: false, error: 'E-posta adresi çok uzun' };
  return { ok: true, value: raw, normalized };
}

export async function getTenantDefaultCountryCode(tenantId: number): Promise<string | null> {
  const result = await query(`SELECT settings FROM tenants WHERE id = $1`, [tenantId]);
  const settings = result.rows[0]?.settings || {};
  const code =
    settings.default_country_code ||
    settings.defaultCountryCode ||
    settings.phone_country_code ||
    null;
  if (!code) return null;
  const digits = String(code).replace(/\D/g, '');
  if (!digits || digits.length < 1 || digits.length > 3) return null;
  return digits;
}

/**
 * Normalize phone to E.164.
 * - Accepts +E.164 directly
 * - Or national number + explicit countryCode / tenant.settings.default_country_code
 * - Never invents a country code
 */
export function normalizePhone(params: {
  value: string;
  countryCode?: string | null;
}): { ok: true; value: string; normalized: string } | { ok: false; error: string } {
  let raw = String(params.value || '').trim();
  if (!raw) return { ok: false, error: 'Telefon numarası gerekli' };

  raw = raw.replace(/[\s().-]/g, '');

  if (raw.startsWith('00')) {
    raw = `+${raw.slice(2)}`;
  }

  if (raw.startsWith('+')) {
    const digits = raw.slice(1).replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) {
      return { ok: false, error: 'Telefon numarası geçersiz.' };
    }
    return { ok: true, value: `+${digits}`, normalized: `+${digits}` };
  }

  const national = raw.replace(/\D/g, '');
  if (!national) return { ok: false, error: 'Telefon numarası geçersiz.' };

  const cc = String(params.countryCode || '').replace(/\D/g, '');
  if (!cc) {
    return {
      ok: false,
      error: 'Telefon numarası geçersiz.',
    };
  }

  let local = national;
  if (local.startsWith('0')) local = local.slice(1);

  // Strip accidental duplicate country code (e.g. value "905323171755" + cc "90")
  if (cc && local.startsWith(cc) && local.length > cc.length) {
    const withoutCc = local.slice(cc.length);
    if (withoutCc.length >= 7 && `${cc}${withoutCc}`.length <= 15) {
      local = withoutCc;
    }
  }

  const combined = `${cc}${local}`;
  if (combined.length < 8 || combined.length > 15) {
    return { ok: false, error: 'Telefon numarası geçersiz.' };
  }

  return { ok: true, value: `+${combined}`, normalized: `+${combined}` };
}

export async function normalizeContactPointValue(params: {
  tenantId: number;
  channelType: 'EMAIL' | 'SMS' | 'WHATSAPP';
  value: string;
  countryCode?: string | null;
}): Promise<{ ok: true; value: string; normalized: string } | { ok: false; error: string }> {
  if (params.channelType === 'EMAIL') {
    return normalizeEmail(params.value);
  }

  let countryCode = params.countryCode || null;
  if (!countryCode) {
    countryCode = await getTenantDefaultCountryCode(params.tenantId);
  }
  return normalizePhone({ value: params.value, countryCode });
}
