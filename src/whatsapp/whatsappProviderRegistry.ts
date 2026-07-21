import { MetaWhatsAppCloudAdapter } from './providers/metaWhatsAppCloudAdapter';
import { WhatsAppProviderAdapter, WhatsAppProviderName } from './WhatsAppProviderAdapter';

const adapters: Record<string, () => WhatsAppProviderAdapter> = {
  META_WHATSAPP_CLOUD: () => new MetaWhatsAppCloudAdapter(),
  // Alias used in product docs / Embedded Signup naming
  META_CLOUD: () => new MetaWhatsAppCloudAdapter(),
};

export function getWhatsAppProviderAdapter(
  provider: WhatsAppProviderName | null | undefined
): WhatsAppProviderAdapter {
  const key = String(provider || '')
    .trim()
    .toUpperCase();
  const factory = adapters[key];
  if (!factory) {
    throw Object.assign(new Error('Desteklenmeyen WhatsApp sağlayıcısı'), {
      code: 'UNSUPPORTED_WA_PROVIDER',
    });
  }
  return factory();
}

export function isSupportedWhatsAppProvider(provider: unknown): boolean {
  return Boolean(adapters[String(provider || '').trim().toUpperCase()]);
}
