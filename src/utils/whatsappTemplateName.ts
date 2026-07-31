/**
 * Normalize a display / raw name into a Meta WhatsApp template name.
 * Rules: lowercase a-z, 0-9, underscore only.
 */

const TR_MAP: Record<string, string> = {
  ç: 'c',
  Ç: 'c',
  ğ: 'g',
  Ğ: 'g',
  ı: 'i',
  I: 'i',
  İ: 'i',
  ö: 'o',
  Ö: 'o',
  ş: 's',
  Ş: 's',
  ü: 'u',
  Ü: 'u',
};

export function normalizeWhatsAppTemplateName(input: string): string {
  let s = String(input || '').trim();
  if (!s) return '';
  s = s
    .split('')
    .map((ch) => TR_MAP[ch] ?? ch)
    .join('');
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.toLowerCase();
  s = s.replace(/[^a-z0-9]+/g, '_');
  s = s.replace(/_+/g, '_').replace(/^_|_$/g, '');
  return s.slice(0, 512);
}

export function isValidWhatsAppTemplateName(name: string): boolean {
  return /^[a-z0-9_]+$/.test(String(name || '')) && String(name).length > 0;
}

export const WHATSAPP_TEMPLATE_CATEGORIES = ['UTILITY', 'MARKETING', 'AUTHENTICATION'] as const;
export type WhatsAppTemplateCategory = (typeof WHATSAPP_TEMPLATE_CATEGORIES)[number];

export function isWhatsAppTemplateCategory(value: unknown): value is WhatsAppTemplateCategory {
  return (
    typeof value === 'string' &&
    (WHATSAPP_TEMPLATE_CATEGORIES as readonly string[]).includes(value.toUpperCase())
  );
}
