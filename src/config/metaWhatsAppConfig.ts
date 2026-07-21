/**
 * Platform-level Meta WhatsApp Cloud / Embedded Signup configuration.
 * Secrets never leave the backend.
 */

export type MetaWhatsAppPublicConfig = {
  configured: boolean;
  appIdPresent: boolean;
  configIdPresent: boolean;
  appSecretPresent: boolean;
  webhookVerifyTokenPresent: boolean;
  publicBackendUrlPresent: boolean;
  graphApiVersion: string;
  webhookUrl: string | null;
  missing: string[];
};

function trim(value: unknown): string {
  return String(value || '').trim();
}

export function getMetaGraphApiVersion(): string {
  const raw = trim(process.env.META_GRAPH_API_VERSION) || 'v23.0';
  return raw.startsWith('v') ? raw : `v${raw}`;
}

export function getMetaAppId(): string {
  return trim(process.env.META_APP_ID);
}

export function getMetaAppSecret(): string {
  return trim(process.env.META_APP_SECRET);
}

export function getMetaWhatsAppConfigId(): string {
  return trim(process.env.META_WHATSAPP_CONFIG_ID);
}

export function getMetaWhatsAppWebhookVerifyToken(): string {
  return trim(process.env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN);
}

export function getPublicBackendUrl(): string {
  return trim(process.env.PUBLIC_BACKEND_URL || process.env.BACKEND_URL).replace(/\/+$/, '');
}

export function getWhatsAppWebhookUrl(): string | null {
  const base = getPublicBackendUrl();
  if (!base) return null;
  return `${base}/api/webhooks/whatsapp`;
}

/** True when Embedded Signup can run end-to-end on the server. */
export function isMetaEmbeddedSignupReady(): boolean {
  return Boolean(
    getMetaAppId() &&
      getMetaAppSecret() &&
      getMetaWhatsAppConfigId() &&
      getMetaWhatsAppWebhookVerifyToken()
  );
}

export function getMetaWhatsAppPublicConfig(): MetaWhatsAppPublicConfig {
  const appIdPresent = Boolean(getMetaAppId());
  const configIdPresent = Boolean(getMetaWhatsAppConfigId());
  const appSecretPresent = Boolean(getMetaAppSecret());
  const webhookVerifyTokenPresent = Boolean(getMetaWhatsAppWebhookVerifyToken());
  const publicBackendUrlPresent = Boolean(getPublicBackendUrl());
  const webhookUrl = getWhatsAppWebhookUrl();
  const missing: string[] = [];
  if (!appIdPresent) missing.push('META_APP_ID');
  if (!appSecretPresent) missing.push('META_APP_SECRET');
  if (!configIdPresent) missing.push('META_WHATSAPP_CONFIG_ID');
  if (!webhookVerifyTokenPresent) missing.push('META_WHATSAPP_WEBHOOK_VERIFY_TOKEN');
  if (!publicBackendUrlPresent) missing.push('PUBLIC_BACKEND_URL');

  return {
    configured: isMetaEmbeddedSignupReady() && publicBackendUrlPresent,
    appIdPresent,
    configIdPresent,
    appSecretPresent,
    webhookVerifyTokenPresent,
    publicBackendUrlPresent,
    graphApiVersion: getMetaGraphApiVersion(),
    webhookUrl,
    missing,
  };
}

export function graphApiBase(version?: string): string {
  const v = version || getMetaGraphApiVersion();
  const normalized = v.startsWith('v') ? v : `v${v}`;
  return `https://graph.facebook.com/${normalized}`;
}
