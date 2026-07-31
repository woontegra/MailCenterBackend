import { Response } from 'express';

export type ChannelType = 'EMAIL' | 'SMS' | 'WHATSAPP';
export type ChannelStatus = 'NOT_CONFIGURED' | 'ACTIVE' | 'DISABLED' | 'ERROR';

export const CHANNEL_TYPES: ChannelType[] = ['EMAIL', 'SMS', 'WHATSAPP'];
export const CHANNEL_STATUSES: ChannelStatus[] = ['NOT_CONFIGURED', 'ACTIVE', 'DISABLED', 'ERROR'];

export function isChannelType(value: unknown): value is ChannelType {
  return typeof value === 'string' && CHANNEL_TYPES.includes(value as ChannelType);
}

export function isChannelStatus(value: unknown): value is ChannelStatus {
  return typeof value === 'string' && CHANNEL_STATUSES.includes(value as ChannelStatus);
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

export function notFound(res: Response, error = 'Not found') {
  return res.status(404).json({ error });
}

export function badRequest(res: Response, error: string) {
  return res.status(400).json({ error });
}

export function conflict(res: Response, error: string) {
  return res.status(409).json({ error });
}

export function sanitizeConnection<T extends Record<string, unknown>>(row: T) {
  const { encrypted_credentials, ...rest } = row as T & { encrypted_credentials?: unknown };
  const settings =
    rest.settings && typeof rest.settings === 'object' && !Array.isArray(rest.settings)
      ? (rest.settings as Record<string, unknown>)
      : {};

  const phone_number = String(
    settings.business_phone_number ||
      settings.business_phone ||
      settings.display_phone_number ||
      settings.phone_number ||
      ''
  ).trim() || null;
  const phone_number_id = String(settings.phone_number_id || '').trim() || null;
  const waba_id = String(settings.waba_id || '').trim() || null;
  const connection_type = String(
    settings.connection_type || settings.connection_method || ''
  ).trim() || null;

  return {
    ...rest,
    has_credentials: Boolean(encrypted_credentials),
    phone_number,
    phone_number_id,
    waba_id,
    connection_type,
  };
}

/** Digits-only compare for Meta display phones (+90 532… vs +90532…). */
export function whatsappPhoneDigits(value: unknown): string {
  return String(value || '').replace(/\D/g, '');
}

export function isMetaTestWhatsAppPhone(value: unknown): boolean {
  const d = whatsappPhoneDigits(value);
  // Meta Cloud API test line used in review sandboxes
  return d === '15551548955' || d.endsWith('5551548955');
}

export function canActivateChannel(params: {
  channelType: ChannelType;
  encryptedCredentials?: string | null;
  mailAccountId?: number | null;
}): { ok: boolean; error?: string } {
  const { channelType, encryptedCredentials, mailAccountId } = params;

  if (channelType === 'EMAIL') {
    if (mailAccountId || encryptedCredentials) {
      return { ok: true };
    }
    return {
      ok: false,
      error: 'EMAIL connection cannot be ACTIVE without a linked mail account or credentials',
    };
  }

  if (!encryptedCredentials) {
    return {
      ok: false,
      error: `${channelType} connection cannot be ACTIVE without credentials`,
    };
  }

  return { ok: true };
}

export function validateTemplateSubject(channelType: ChannelType | null | undefined, subject: unknown) {
  if (channelType === 'EMAIL') {
    return { ok: true as const };
  }

  if (subject !== undefined && subject !== null && String(subject).trim() !== '') {
    return {
      ok: false as const,
      error: 'Subject is only allowed for EMAIL templates',
    };
  }

  return { ok: true as const };
}
