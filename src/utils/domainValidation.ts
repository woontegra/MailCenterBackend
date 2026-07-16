export type DnsCheckStatus = 'NOT_CHECKED' | 'VALID' | 'WARNING' | 'INVALID' | 'ERROR';

const DOMAIN_RE =
  /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

/**
 * Normalize and validate a bare domain (no protocol, path, port, wildcard).
 */
export function normalizeDomainInput(input: unknown): { ok: true; domain: string } | { ok: false; error: string } {
  if (input === null || input === undefined || input === '') {
    return { ok: false, error: 'Domain gerekli' };
  }

  let raw = String(input).trim().toLowerCase();

  if (/[\s<>"'`]/.test(raw)) {
    return { ok: false, error: 'Domain geçersiz karakterler içeriyor' };
  }

  if (raw.includes('://') || raw.includes('/') || raw.includes('\\')) {
    return { ok: false, error: 'Domain protokol veya path içeremez' };
  }

  if (raw.includes(':') || raw.includes('@')) {
    return { ok: false, error: 'Domain port veya e-posta adresi olamaz' };
  }

  if (raw.startsWith('*.') || raw.includes('*')) {
    return { ok: false, error: 'Wildcard domain kabul edilmez' };
  }

  raw = raw.replace(/\.+$/, '');

  if (!DOMAIN_RE.test(raw)) {
    return { ok: false, error: 'Geçersiz alan adı biçimi' };
  }

  return { ok: true, domain: raw };
}

export function extractEmailDomain(email: string): string | null {
  const trimmed = String(email || '').trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;
  const domainPart = trimmed.slice(at + 1);
  const normalized = normalizeDomainInput(domainPart);
  return normalized.ok ? normalized.domain : null;
}

export function domainsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function rankStatus(status: DnsCheckStatus): number {
  switch (status) {
    case 'ERROR':
      return 4;
    case 'INVALID':
      return 3;
    case 'WARNING':
      return 2;
    case 'VALID':
      return 1;
    default:
      return 0;
  }
}

export function aggregateOverallStatus(statuses: DnsCheckStatus[]): DnsCheckStatus {
  if (statuses.length === 0) return 'NOT_CHECKED';
  if (statuses.every((s) => s === 'NOT_CHECKED')) return 'NOT_CHECKED';

  let worst: DnsCheckStatus = 'VALID';
  for (const status of statuses) {
    if (status === 'NOT_CHECKED') continue;
    if (rankStatus(status) > rankStatus(worst)) {
      worst = status;
    }
  }
  return worst;
}

export function truncateDnsText(value: string | null | undefined, max = 2000): string | null {
  if (!value) return null;
  const cleaned = String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max)}…`;
}
