import { NetgsmAdapter } from './providers/netgsmAdapter';
import { SmsProviderAdapter, SmsProviderName } from './SmsProviderAdapter';

const adapters: Record<string, () => SmsProviderAdapter> = {
  NETGSM: () => new NetgsmAdapter(),
};

export function getSmsProviderAdapter(provider: SmsProviderName | null | undefined): SmsProviderAdapter {
  const key = String(provider || '')
    .trim()
    .toUpperCase();
  const factory = adapters[key];
  if (!factory) {
    throw Object.assign(new Error('Desteklenmeyen SMS sağlayıcısı'), {
      code: 'UNSUPPORTED_SMS_PROVIDER',
    });
  }
  return factory();
}

export function isSupportedSmsProvider(provider: unknown): boolean {
  return Boolean(adapters[String(provider || '').trim().toUpperCase()]);
}
