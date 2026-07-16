import { encryptCredential, decryptCredential } from '../utils/mailCredentialsCrypto';
import { WhatsAppConnectionConfig, WhatsAppCredentials } from './WhatsAppProviderAdapter';
import { DEFAULT_API_VERSION } from './providers/metaWhatsAppCloudAdapter';

export type WhatsAppSettings = {
  waba_id?: string | null;
  phone_number_id?: string | null;
  business_phone_number?: string | null;
  api_version?: string | null;
};

type PackedSecrets = {
  access_token: string;
  app_secret: string;
  webhook_verify_token: string;
};

export function packWhatsAppCredentials(input: {
  access_token?: string;
  app_secret?: string;
  webhook_verify_token?: string;
}): string {
  const access_token = String(input.access_token || '').trim();
  const app_secret = String(input.app_secret || '').trim();
  const webhook_verify_token = String(input.webhook_verify_token || '').trim();
  if (!access_token || !app_secret || !webhook_verify_token) {
    throw Object.assign(
      new Error('Access Token, App Secret ve Webhook Verify Token gerekli'),
      { code: 'INVALID_CREDENTIALS' }
    );
  }
  const payload: PackedSecrets = { access_token, app_secret, webhook_verify_token };
  return encryptCredential(JSON.stringify(payload));
}

export function unpackWhatsAppCredentials(
  encrypted: string | null | undefined
): WhatsAppCredentials {
  if (!encrypted) {
    throw Object.assign(new Error('WhatsApp kimlik bilgileri eksik'), {
      code: 'MISSING_CREDENTIALS',
    });
  }
  const raw = decryptCredential(encrypted);
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('WhatsApp kimlik bilgileri okunamadı'), {
      code: 'INVALID_CREDENTIALS',
    });
  }
  const accessToken = String(parsed.access_token || parsed.accessToken || '').trim();
  const appSecret = String(parsed.app_secret || parsed.appSecret || '').trim();
  const webhookVerifyToken = String(
    parsed.webhook_verify_token || parsed.webhookVerifyToken || ''
  ).trim();
  if (!accessToken || !appSecret || !webhookVerifyToken) {
    throw Object.assign(new Error('WhatsApp kimlik bilgileri eksik'), {
      code: 'INVALID_CREDENTIALS',
    });
  }
  return { accessToken, appSecret, webhookVerifyToken };
}

export function mergeWhatsAppCredentialUpdate(params: {
  existingEncrypted: string | null;
  access_token?: string | null;
  app_secret?: string | null;
  webhook_verify_token?: string | null;
}): string | null {
  const hasToken =
    params.access_token != null && String(params.access_token).trim() !== '';
  const hasSecret = params.app_secret != null && String(params.app_secret).trim() !== '';
  const hasVerify =
    params.webhook_verify_token != null &&
    String(params.webhook_verify_token).trim() !== '';

  if (!hasToken && !hasSecret && !hasVerify) {
    return params.existingEncrypted;
  }

  let current: WhatsAppCredentials | null = null;
  if (params.existingEncrypted) {
    try {
      current = unpackWhatsAppCredentials(params.existingEncrypted);
    } catch {
      current = null;
    }
  }

  return packWhatsAppCredentials({
    access_token: hasToken
      ? String(params.access_token).trim()
      : current?.accessToken || '',
    app_secret: hasSecret
      ? String(params.app_secret).trim()
      : current?.appSecret || '',
    webhook_verify_token: hasVerify
      ? String(params.webhook_verify_token).trim()
      : current?.webhookVerifyToken || '',
  });
}

export function parseWhatsAppSettings(settings: any): WhatsAppConnectionConfig {
  const s = settings || {};
  const phoneNumberId = String(s.phone_number_id || s.phoneNumberId || '').trim();
  const wabaId = String(s.waba_id || s.wabaId || '').trim();
  if (!phoneNumberId || !wabaId) {
    throw Object.assign(new Error('WABA ID ve Phone Number ID gerekli'), {
      code: 'INVALID_SETTINGS',
    });
  }
  return {
    wabaId,
    phoneNumberId,
    businessPhoneNumber: s.business_phone_number || s.businessPhoneNumber || null,
    apiVersion: String(s.api_version || s.apiVersion || DEFAULT_API_VERSION),
  };
}
