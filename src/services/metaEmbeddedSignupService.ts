/**
 * Meta Embedded Signup + Graph API helpers for WhatsApp Cloud.
 * Never logs access tokens or app secrets.
 */

import {
  getMetaAppId,
  getMetaAppSecret,
  getMetaGraphApiVersion,
  getMetaWhatsAppWebhookVerifyToken,
  graphApiBase,
  isMetaEmbeddedSignupReady,
} from '../config/metaWhatsAppConfig';
import { packWhatsAppCredentials } from '../whatsapp/whatsappCredentials';

export type MetaSignupSessionInfo = {
  wabaId?: string | null;
  phoneNumberId?: string | null;
  businessId?: string | null;
  raw?: Record<string, unknown> | null;
};

export type MetaPhoneProfile = {
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
};

export type MetaWabaProfile = {
  wabaId: string;
  name: string | null;
};

function sanitizeGraphError(data: any, status?: number): string {
  const err = data?.error || data;
  const msg = String(err?.message || err?.error_user_msg || `Meta API hatası (${status || '?'})`)
    .replace(/EAA[A-Za-z0-9]+/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 300);
  return msg;
}

async function graphJson(
  url: string,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; data: any }> {
  try {
    const res = await fetch(url, init);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: { message: 'Meta API yanıt vermedi' } } };
  }
}

/**
 * Exchange Embedded Signup authorization code for a user access token.
 * Uses app secret on the server only.
 */
export async function exchangeEmbeddedSignupCode(authorizationCode: string): Promise<{
  accessToken: string;
}> {
  if (!isMetaEmbeddedSignupReady()) {
    throw Object.assign(new Error('Meta WhatsApp yapılandırması tamamlanmamış'), {
      code: 'META_CONFIG_INCOMPLETE',
    });
  }
  const code = String(authorizationCode || '').trim();
  if (!code) {
    throw Object.assign(new Error('Authorization code gerekli'), { code: 'MISSING_CODE' });
  }

  const version = getMetaGraphApiVersion();
  const params = new URLSearchParams({
    client_id: getMetaAppId(),
    client_secret: getMetaAppSecret(),
    code,
  });
  const url = `${graphApiBase(version)}/oauth/access_token?${params.toString()}`;
  const { ok, status, data } = await graphJson(url);
  const accessToken = String(data?.access_token || '').trim();
  if (!ok || !accessToken) {
    throw Object.assign(new Error(sanitizeGraphError(data, status) || 'Token alınamadı'), {
      code: 'TOKEN_EXCHANGE_FAILED',
    });
  }
  return { accessToken };
}

export async function fetchPhoneNumberProfile(params: {
  accessToken: string;
  phoneNumberId: string;
  apiVersion?: string;
}): Promise<MetaPhoneProfile> {
  const version = params.apiVersion || getMetaGraphApiVersion();
  const fields = 'display_phone_number,verified_name,quality_rating';
  const url = `${graphApiBase(version)}/${encodeURIComponent(params.phoneNumberId)}?fields=${fields}`;
  const { ok, status, data } = await graphJson(url, {
    headers: { Authorization: `Bearer ${params.accessToken}` },
  });
  if (!ok) {
    throw Object.assign(new Error(sanitizeGraphError(data, status) || 'Telefon numarası doğrulanamadı'), {
      code: 'PHONE_LOOKUP_FAILED',
    });
  }
  return {
    phoneNumberId: params.phoneNumberId,
    displayPhoneNumber: data?.display_phone_number || null,
    verifiedName: data?.verified_name || null,
    qualityRating: data?.quality_rating || null,
  };
}

export async function fetchWabaProfile(params: {
  accessToken: string;
  wabaId: string;
  apiVersion?: string;
}): Promise<MetaWabaProfile> {
  const version = params.apiVersion || getMetaGraphApiVersion();
  const url = `${graphApiBase(version)}/${encodeURIComponent(params.wabaId)}?fields=id,name`;
  const { ok, status, data } = await graphJson(url, {
    headers: { Authorization: `Bearer ${params.accessToken}` },
  });
  if (!ok) {
    throw Object.assign(new Error(sanitizeGraphError(data, status) || 'WABA doğrulanamadı'), {
      code: 'WABA_LOOKUP_FAILED',
    });
  }
  return {
    wabaId: String(data?.id || params.wabaId),
    name: data?.name || null,
  };
}

/**
 * Subscribe the Meta App to the WABA so webhooks are delivered.
 * Idempotent: already-subscribed returns success.
 */
export async function subscribeAppToWaba(params: {
  accessToken: string;
  wabaId: string;
  apiVersion?: string;
}): Promise<{ subscribed: boolean; alreadySubscribed?: boolean }> {
  const version = params.apiVersion || getMetaGraphApiVersion();
  const url = `${graphApiBase(version)}/${encodeURIComponent(params.wabaId)}/subscribed_apps`;
  const { ok, status, data } = await graphJson(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      'Content-Type': 'application/json',
    },
  });
  if (ok && (data?.success === true || data === true)) {
    return { subscribed: true };
  }
  // Some Meta responses return already subscribed without hard failure
  const msg = String(data?.error?.message || '').toLowerCase();
  if (msg.includes('already') || msg.includes('subscribed')) {
    return { subscribed: true, alreadySubscribed: true };
  }
  throw Object.assign(new Error(sanitizeGraphError(data, status) || 'WABA webhook aboneliği başarısız'), {
    code: 'WABA_SUBSCRIBE_FAILED',
  });
}

export async function unsubscribeAppFromWaba(params: {
  accessToken: string;
  wabaId: string;
  apiVersion?: string;
}): Promise<{ unsubscribed: boolean }> {
  const version = params.apiVersion || getMetaGraphApiVersion();
  const url = `${graphApiBase(version)}/${encodeURIComponent(params.wabaId)}/subscribed_apps`;
  const { ok, status, data } = await graphJson(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${params.accessToken}` },
  });
  if (!ok && status !== 404) {
    throw Object.assign(new Error(sanitizeGraphError(data, status) || 'WABA abonelik kaldırma başarısız'), {
      code: 'WABA_UNSUBSCRIBE_FAILED',
    });
  }
  return { unsubscribed: true };
}

export type MetaMessageTemplate = {
  id: string;
  name: string;
  language: string;
  category: string | null;
  status: string;
  components: unknown;
};

export async function fetchWabaMessageTemplates(params: {
  accessToken: string;
  wabaId: string;
  apiVersion?: string;
}): Promise<MetaMessageTemplate[]> {
  const version = params.apiVersion || getMetaGraphApiVersion();
  const templates: MetaMessageTemplate[] = [];
  let url: string | null =
    `${graphApiBase(version)}/${encodeURIComponent(params.wabaId)}/message_templates` +
    `?limit=100&fields=id,name,language,status,category,components`;

  while (url) {
    const { ok, status, data } = await graphJson(url, {
      headers: { Authorization: `Bearer ${params.accessToken}` },
    });
    if (!ok) {
      throw Object.assign(new Error(sanitizeGraphError(data, status) || 'Şablonlar alınamadı'), {
        code: 'TEMPLATE_SYNC_FAILED',
      });
    }
    for (const row of data?.data || []) {
      templates.push({
        id: String(row.id || ''),
        name: String(row.name || ''),
        language: String(row.language || ''),
        category: row.category || null,
        status: String(row.status || 'UNKNOWN').toUpperCase(),
        components: row.components || [],
      });
    }
    url = data?.paging?.next || null;
  }

  return templates;
}

export function packPlatformWhatsAppCredentials(accessToken: string): string {
  return packWhatsAppCredentials({
    access_token: accessToken,
    app_secret: getMetaAppSecret(),
    webhook_verify_token: getMetaWhatsAppWebhookVerifyToken(),
  });
}

export function extractSignupIds(
  session: MetaSignupSessionInfo | null | undefined,
  options?: { allowMissingPhoneNumberId?: boolean }
): {
  wabaId: string;
  phoneNumberId: string;
  businessId: string | null;
} {
  const raw = (session?.raw || {}) as Record<string, any>;
  const data = raw.data || raw;
  const wabaId = String(
    session?.wabaId ||
      data?.waba_id ||
      data?.wabaId ||
      raw?.waba_id ||
      ''
  ).trim();
  const phoneNumberId = String(
    session?.phoneNumberId ||
      data?.phone_number_id ||
      data?.phoneNumberId ||
      raw?.phone_number_id ||
      ''
  ).trim();
  const businessId =
    String(
      session?.businessId || data?.business_id || data?.businessId || raw?.business_id || ''
    ).trim() || null;

  if (!wabaId) {
    throw Object.assign(new Error('Meta oturumunda WABA ID eksik'), {
      code: 'MISSING_SIGNUP_IDS',
    });
  }
  if (!phoneNumberId && !options?.allowMissingPhoneNumberId) {
    throw Object.assign(
      new Error('Meta oturumunda WABA ID veya Phone Number ID eksik'),
      { code: 'MISSING_SIGNUP_IDS' }
    );
  }
  return { wabaId, phoneNumberId, businessId };
}

/**
 * List phone numbers on a WABA. Used when coexistence FINISH only returns waba_id.
 */
export async function listWabaPhoneNumbers(params: {
  accessToken: string;
  wabaId: string;
  apiVersion?: string;
}): Promise<
  Array<{
    phoneNumberId: string;
    displayPhoneNumber: string | null;
    verifiedName: string | null;
    isOnBizApp: boolean | null;
    platformType: string | null;
  }>
> {
  const version = params.apiVersion || getMetaGraphApiVersion();
  const fields = 'id,display_phone_number,verified_name,is_on_biz_app,platform_type';
  const url =
    `${graphApiBase(version)}/${encodeURIComponent(params.wabaId)}/phone_numbers` +
    `?fields=${fields}&limit=50`;
  const { ok, status, data } = await graphJson(url, {
    headers: { Authorization: `Bearer ${params.accessToken}` },
  });
  if (!ok) {
    throw Object.assign(
      new Error(sanitizeGraphError(data, status) || 'WABA telefon numaraları alınamadı'),
      { code: 'WABA_PHONE_LIST_FAILED' }
    );
  }
  return (data?.data || []).map((row: any) => ({
    phoneNumberId: String(row.id || '').trim(),
    displayPhoneNumber: row.display_phone_number || null,
    verifiedName: row.verified_name || null,
    isOnBizApp: typeof row.is_on_biz_app === 'boolean' ? row.is_on_biz_app : null,
    platformType: row.platform_type ? String(row.platform_type) : null,
  })).filter((row: { phoneNumberId: string }) => Boolean(row.phoneNumberId));
}

export async function resolvePhoneNumberIdForWaba(params: {
  accessToken: string;
  wabaId: string;
  preferredPhoneNumberId?: string | null;
  apiVersion?: string;
}): Promise<{
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  isOnBizApp: boolean | null;
  platformType: string | null;
}> {
  const numbers = await listWabaPhoneNumbers(params);
  if (numbers.length === 0) {
    throw Object.assign(new Error('WABA üzerinde telefon numarası bulunamadı'), {
      code: 'WABA_PHONE_EMPTY',
    });
  }
  const preferred = String(params.preferredPhoneNumberId || '').trim();
  if (preferred) {
    const match = numbers.find((n) => n.phoneNumberId === preferred);
    if (match) return match;
  }
  const onBiz = numbers.find((n) => n.isOnBizApp === true);
  if (onBiz) return onBiz;
  if (numbers.length === 1) return numbers[0];
  throw Object.assign(
    new Error('WABA üzerinde birden fazla numara var; session phone_number_id gerekli'),
    { code: 'WABA_PHONE_AMBIGUOUS' }
  );
}

export async function verifyConnectionAgainstMeta(params: {
  accessToken: string;
  wabaId: string;
  phoneNumberId: string;
  apiVersion?: string;
}): Promise<{
  ok: boolean;
  phone: MetaPhoneProfile;
  waba: MetaWabaProfile;
  subscribed: boolean;
  safeMessage: string;
}> {
  const phone = await fetchPhoneNumberProfile(params);
  const waba = await fetchWabaProfile(params);

  // Check subscribed_apps
  const version = params.apiVersion || getMetaGraphApiVersion();
  const url = `${graphApiBase(version)}/${encodeURIComponent(params.wabaId)}/subscribed_apps`;
  const { ok, data } = await graphJson(url, {
    headers: { Authorization: `Bearer ${params.accessToken}` },
  });
  const appId = getMetaAppId();
  let subscribed = false;
  if (ok && Array.isArray(data?.data)) {
    subscribed = data.data.some(
      (row: any) => String(row.id || row.whatsapp_business_api_data?.id || '') === appId
    );
  }

  return {
    ok: Boolean(phone.phoneNumberId && waba.wabaId),
    phone,
    waba,
    subscribed,
    safeMessage: subscribed
      ? 'Bağlantı doğrulandı; WABA aboneliği aktif'
      : 'Bağlantı doğrulandı; WABA webhook aboneliği eksik olabilir',
  };
}
