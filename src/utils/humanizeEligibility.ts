const TECHNICAL_TERMS =
  /\b(OPTED_IN|OPTED_OUT|UNKNOWN|WABA|PNID|idempotency|provider|payload)\b/gi;

export function humanizeRecipientBlock(code?: string, fallback?: string): string {
  switch (String(code || '').toUpperCase()) {
    case 'OPTED_OUT':
      return 'Mesaj almak istemiyor';
    case 'UNKNOWN_PREFERENCE':
    case 'NOT_OPTED_IN':
      return 'İletişim izni yok';
    case 'BLOCKED':
    case 'CONTACT_BLOCKED':
      return 'Engelli liste';
    case 'INVALID_ADDRESS':
      return 'Geçersiz telefon';
    case 'DUPLICATE':
      return 'Mükerrer numara';
    case 'MISSING_VARIABLE':
      return 'Eksik şablon değişkeni';
    default:
      break;
  }

  const raw = String(fallback || '').trim();
  if (!raw) return 'Gönderilemez';
  return raw.replace(TECHNICAL_TERMS, '').replace(/\s+/g, ' ').trim() || 'Gönderilemez';
}

export function humanizeCampaignRecipientError(error?: string | null): string {
  const cleaned = humanizeRecipientBlock(undefined, String(error || ''));
  if (/^\[?redacted/i.test(cleaned)) return 'Gönderim başarısız';
  return cleaned || 'Gönderim başarısız';
}
