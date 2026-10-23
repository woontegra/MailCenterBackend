/**
 * Settings merge for Embedded Signup reconnects: keep everything the connection already
 * knows (history markers, operator flags, previous disconnection info) and only overwrite
 * what Meta just re-confirmed.
 */

/** Fresh nulls never erase these existing values. */
const KEEP_EXISTING_WHEN_FRESH_EMPTY = new Set([
  'last_inbound_at',
  'last_outbound_at',
  'business_id',
  'business_phone_number',
  'verified_name',
  'quality_rating',
  'waba_name',
]);

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

export function mergeReconnectSettings(params: {
  existing: unknown;
  fresh: Record<string, unknown>;
  coexistence: boolean;
  now: Date;
  isOnBizApp?: boolean | null;
  platformType?: string | null;
  credentialsRotated: boolean;
}): Record<string, unknown> {
  const existing = asObject(params.existing);
  const hadExisting = Object.keys(existing).length > 0;
  const merged: Record<string, unknown> = { ...existing };
  const nowIso = params.now.toISOString();

  for (const [key, value] of Object.entries(params.fresh)) {
    if (isEmpty(value) && KEEP_EXISTING_WHEN_FRESH_EMPTY.has(key) && !isEmpty(existing[key])) {
      continue;
    }
    merged[key] = value;
  }

  // A successful reconnect clears stale error markers.
  merged.last_error = null;
  if ('last_error_code' in merged) merged.last_error_code = null;

  if (params.coexistence) {
    if (!isEmpty(existing.coexistence_onboarded_at)) {
      merged.previous_coexistence_onboarded_at = existing.coexistence_onboarded_at;
    }
    merged.coexistence_onboarded_at = nowIso;
    merged.coexistence_status = 'CONNECTED';
    merged.coexistence_status_at = nowIso;
    merged.coexistence_verified_at = nowIso;
    merged.is_on_biz_app = params.isOnBizApp ?? null;
    merged.platform_type = params.platformType ?? null;
  }

  if (params.credentialsRotated) merged.credentials_rotated_at = nowIso;
  if (hadExisting) {
    merged.reconnected_at = nowIso;
    merged.reconnect_count = Number(existing.reconnect_count || 0) + 1;
  }

  return merged;
}

/** Coexistence verification per Meta docs: is_on_biz_app=true and platform_type=CLOUD_API. */
export function coexistenceVerificationWarnings(params: {
  isOnBizApp: boolean | null | undefined;
  platformType: string | null | undefined;
  lookupFailed?: boolean;
}): string[] {
  if (params.lookupFailed) {
    return ['Meta coexistence durumu (is_on_biz_app / platform_type) okunamadı; bağlantıyı doğrulayın.'];
  }
  const warnings: string[] = [];
  if (params.isOnBizApp !== true) {
    warnings.push('Meta numaranın WhatsApp Business uygulamasında aktif olduğunu doğrulamadı (is_on_biz_app).');
  }
  if (String(params.platformType || '').toUpperCase() !== 'CLOUD_API') {
    warnings.push(`Numara platform türü CLOUD_API değil (${params.platformType || 'bilinmiyor'}).`);
  }
  return warnings;
}
