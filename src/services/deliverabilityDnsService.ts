import dns from 'dns/promises';
import {
  aggregateOverallStatus,
  DnsCheckStatus,
  normalizeDomainInput,
  truncateDnsText,
} from '../utils/domainValidation';

const DNS_TIMEOUT_MS = 8_000;

export type DeliverabilityCheckInput = {
  domain: string;
  dkimSelector?: string | null;
};

export type DeliverabilityWarning = {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  recommendation?: string;
};

export type DeliverabilityCheckResult = {
  domain: string;
  spf_status: DnsCheckStatus;
  spf_record: string | null;
  dkim_status: DnsCheckStatus;
  dkim_selector: string | null;
  dkim_record: string | null;
  dmarc_status: DnsCheckStatus;
  dmarc_record: string | null;
  mx_status: DnsCheckStatus;
  mx_records: Array<{ exchange: string; priority: number }>;
  overall_status: DnsCheckStatus;
  warnings: DeliverabilityWarning[];
  checked_at: string;
};

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('DNS_TIMEOUT'), { code: 'DNS_TIMEOUT' })), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function flattenTxt(records: string[][]): string[] {
  return records.map((chunks) => chunks.join(''));
}

async function safeResolveTxt(name: string): Promise<{ records: string[]; error?: string }> {
  try {
    const raw = await withTimeout(dns.resolveTxt(name), DNS_TIMEOUT_MS);
    return { records: flattenTxt(raw) };
  } catch (error: any) {
    const code = error?.code || '';
    if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'SERVFAIL') {
      return { records: [] };
    }
    if (code === 'DNS_TIMEOUT' || error?.message === 'DNS_TIMEOUT') {
      return { records: [], error: 'timeout' };
    }
    return { records: [], error: 'lookup_failed' };
  }
}

async function safeResolveMx(domain: string): Promise<{
  records: Array<{ exchange: string; priority: number }>;
  error?: string;
}> {
  try {
    const raw = await withTimeout(dns.resolveMx(domain), DNS_TIMEOUT_MS);
    return {
      records: raw
        .map((row) => ({
          exchange: String(row.exchange || '').toLowerCase(),
          priority: Number(row.priority) || 0,
        }))
        .filter((row) => row.exchange)
        .sort((a, b) => a.priority - b.priority)
        .slice(0, 20),
    };
  } catch (error: any) {
    const code = error?.code || '';
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      return { records: [] };
    }
    if (code === 'DNS_TIMEOUT' || error?.message === 'DNS_TIMEOUT') {
      return { records: [], error: 'timeout' };
    }
    return { records: [], error: 'lookup_failed' };
  }
}

function analyzeSpf(txtRecords: string[], warnings: DeliverabilityWarning[]): {
  status: DnsCheckStatus;
  record: string | null;
} {
  const spfRecords = txtRecords.filter((r) => /^v=spf1\b/i.test(r.trim()));

  if (spfRecords.length === 0) {
    warnings.push({
      code: 'SPF_MISSING',
      severity: 'error',
      message: 'SPF TXT kaydı bulunamadı',
      recommendation: 'DNS sağlayıcınızda v=spf1 ile başlayan tek bir TXT kaydı ekleyin.',
    });
    return { status: 'INVALID', record: null };
  }

  if (spfRecords.length > 1) {
    warnings.push({
      code: 'SPF_MULTIPLE',
      severity: 'error',
      message: 'Aynı domain için birden fazla SPF kaydı bulundu',
      recommendation: 'Yalnızca tek SPF kaydı bırakın; birden fazla SPF geçersiz kabul edilir.',
    });
    return {
      status: 'INVALID',
      record: truncateDnsText(spfRecords.join('\n')),
    };
  }

  const record = spfRecords[0].trim();
  if (!/^v=spf1\b/i.test(record)) {
    warnings.push({
      code: 'SPF_MALFORMED',
      severity: 'error',
      message: 'SPF kaydı geçerli biçimde başlamıyor',
      recommendation: 'Kayıt tam olarak v=spf1 ile başlamalıdır.',
    });
    return { status: 'INVALID', record: truncateDnsText(record) };
  }

  if (!/\s(-all|~all|\?all|\+all)\s*$/i.test(` ${record}`)) {
    warnings.push({
      code: 'SPF_NO_ALL',
      severity: 'warning',
      message: 'SPF kaydında all mekanizması net görünmüyor',
      recommendation: 'Genellikle ~all veya -all ile biten bir politika tercih edilir.',
    });
    return { status: 'WARNING', record: truncateDnsText(record) };
  }

  return { status: 'VALID', record: truncateDnsText(record) };
}

function analyzeDmarc(txtRecords: string[], warnings: DeliverabilityWarning[]): {
  status: DnsCheckStatus;
  record: string | null;
} {
  const dmarcRecords = txtRecords.filter((r) => /^v=dmarc1\b/i.test(r.trim()));

  if (dmarcRecords.length === 0) {
    warnings.push({
      code: 'DMARC_MISSING',
      severity: 'error',
      message: 'DMARC kaydı bulunamadı (_dmarc)',
      recommendation: '_dmarc.alanadiniz için v=DMARC1; p=none/quarantine/reject TXT kaydı ekleyin.',
    });
    return { status: 'INVALID', record: null };
  }

  const record = dmarcRecords[0].trim();
  const policyMatch = /;\s*p\s*=\s*(none|quarantine|reject)\b/i.exec(record) ||
    /\bp\s*=\s*(none|quarantine|reject)\b/i.exec(record);

  if (!policyMatch) {
    warnings.push({
      code: 'DMARC_NO_POLICY',
      severity: 'error',
      message: 'DMARC kaydında p= politikası bulunamadı',
      recommendation: 'p=none, p=quarantine veya p=reject değerlerinden birini ekleyin.',
    });
    return { status: 'INVALID', record: truncateDnsText(record) };
  }

  const policy = policyMatch[1].toLowerCase();
  if (policy === 'none') {
    warnings.push({
      code: 'DMARC_POLICY_NONE',
      severity: 'warning',
      message: 'DMARC politikası p=none (yalnızca izleme)',
      recommendation: 'Hazır olduğunuzda quarantine veya reject politikasına geçmeyi planlayın. Bu, spam’e düşmeyeceğini garanti etmez.',
    });
    return { status: 'WARNING', record: truncateDnsText(record) };
  }

  return { status: 'VALID', record: truncateDnsText(record) };
}

function analyzeDkim(
  txtRecords: string[],
  selector: string | null,
  warnings: DeliverabilityWarning[]
): { status: DnsCheckStatus; record: string | null } {
  if (!selector) {
    warnings.push({
      code: 'DKIM_SELECTOR_REQUIRED',
      severity: 'info',
      message: 'DKIM kontrolü için selector girilmedi',
      recommendation: 'Mail sağlayıcınızın verdiği DKIM selector değerini kaydedip yeniden kontrol edin.',
    });
    return { status: 'NOT_CHECKED', record: null };
  }

  const dkimLike = txtRecords.filter(
    (r) => /v=dkim1/i.test(r) || /p=[a-z0-9+/=\s-]+/i.test(r)
  );

  if (txtRecords.length === 0) {
    warnings.push({
      code: 'DKIM_MISSING',
      severity: 'error',
      message: `DKIM TXT kaydı bulunamadı (${selector}._domainkey)`,
      recommendation: 'Sağlayıcınızın verdiği DKIM TXT kaydını DNS’e ekleyin. Uygulama kaydı sizin yerinize oluşturmaz.',
    });
    return { status: 'INVALID', record: null };
  }

  if (dkimLike.length === 0) {
    warnings.push({
      code: 'DKIM_UNEXPECTED',
      severity: 'warning',
      message: 'Selector altında TXT bulundu ancak DKIM biçimi net değil',
      recommendation: 'Kaydın v=DKIM1 ve p= genel anahtar alanlarını içerdiğini doğrulayın.',
    });
    return { status: 'WARNING', record: truncateDnsText(txtRecords[0]) };
  }

  return { status: 'VALID', record: truncateDnsText(dkimLike[0]) };
}

function analyzeMx(
  records: Array<{ exchange: string; priority: number }>,
  error: string | undefined,
  warnings: DeliverabilityWarning[]
): { status: DnsCheckStatus; records: Array<{ exchange: string; priority: number }> } {
  if (error === 'timeout') {
    warnings.push({
      code: 'MX_TIMEOUT',
      severity: 'error',
      message: 'MX DNS sorgusu zaman aşımına uğradı',
    });
    return { status: 'ERROR', records: [] };
  }
  if (error) {
    warnings.push({
      code: 'MX_LOOKUP_FAILED',
      severity: 'error',
      message: 'MX DNS sorgusu tamamlanamadı',
    });
    return { status: 'ERROR', records: [] };
  }
  if (records.length === 0) {
    warnings.push({
      code: 'MX_MISSING',
      severity: 'error',
      message: 'MX kaydı bulunamadı',
      recommendation: 'Alan adınız için en az bir MX kaydı tanımlayın.',
    });
    return { status: 'INVALID', records: [] };
  }
  return { status: 'VALID', records };
}

export async function runDeliverabilityDnsCheck(
  input: DeliverabilityCheckInput
): Promise<DeliverabilityCheckResult> {
  const normalized = normalizeDomainInput(input.domain);
  if (normalized.ok === false) {
    throw Object.assign(new Error(normalized.error), { code: 'INVALID_DOMAIN' });
  }

  const domain = normalized.domain;
  const selectorRaw = input.dkimSelector ? String(input.dkimSelector).trim().toLowerCase() : '';
  const selector =
    selectorRaw && /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/i.test(selectorRaw)
      ? selectorRaw
      : null;

  const warnings: DeliverabilityWarning[] = [];

  if (input.dkimSelector && !selector) {
    warnings.push({
      code: 'DKIM_SELECTOR_INVALID',
      severity: 'warning',
      message: 'DKIM selector biçimi geçersiz; DKIM kontrolü atlandı',
    });
  }

  type TxtLookup = { records: string[]; error?: string };
  const spfLookup: TxtLookup = await safeResolveTxt(domain);
  const dmarcLookup: TxtLookup = await safeResolveTxt(`_dmarc.${domain}`);
  const mxLookup = await safeResolveMx(domain);
  const dkimLookup: TxtLookup = selector
    ? await safeResolveTxt(`${selector}._domainkey.${domain}`)
    : { records: [] };

  if (spfLookup.error === 'timeout') {
    warnings.push({
      code: 'SPF_TIMEOUT',
      severity: 'error',
      message: 'SPF DNS sorgusu zaman aşımına uğradı',
    });
  }
  if (dmarcLookup.error === 'timeout') {
    warnings.push({
      code: 'DMARC_TIMEOUT',
      severity: 'error',
      message: 'DMARC DNS sorgusu zaman aşımına uğradı',
    });
  }
  if (dkimLookup.error === 'timeout') {
    warnings.push({
      code: 'DKIM_TIMEOUT',
      severity: 'error',
      message: 'DKIM DNS sorgusu zaman aşımına uğradı',
    });
  }

  const spf =
    spfLookup.error === 'timeout' || spfLookup.error === 'lookup_failed'
      ? { status: 'ERROR' as DnsCheckStatus, record: null }
      : analyzeSpf(spfLookup.records, warnings);

  const dmarc =
    dmarcLookup.error === 'timeout' || dmarcLookup.error === 'lookup_failed'
      ? { status: 'ERROR' as DnsCheckStatus, record: null }
      : analyzeDmarc(dmarcLookup.records, warnings);

  const mx = analyzeMx(mxLookup.records, mxLookup.error, warnings);

  const dkim =
    !selector
      ? { status: 'NOT_CHECKED' as DnsCheckStatus, record: null }
      : dkimLookup.error === 'timeout' || dkimLookup.error === 'lookup_failed'
        ? { status: 'ERROR' as DnsCheckStatus, record: null }
        : analyzeDkim(dkimLookup.records, selector, warnings);

  warnings.push({
    code: 'NO_SPAM_GUARANTEE',
    severity: 'info',
    message:
      'Bu kontrol yalnızca teknik DNS hazırlığını gösterir; e-postanın spam klasörüne düşmeyeceğini garanti etmez.',
  });

  const statusesForOverall: DnsCheckStatus[] = [spf.status, dmarc.status, mx.status];
  if (dkim.status !== 'NOT_CHECKED') statusesForOverall.push(dkim.status);

  return {
    domain,
    spf_status: spf.status,
    spf_record: spf.record,
    dkim_status: dkim.status,
    dkim_selector: selector,
    dkim_record: dkim.record,
    dmarc_status: dmarc.status,
    dmarc_record: dmarc.record,
    mx_status: mx.status,
    mx_records: mx.records,
    overall_status: aggregateOverallStatus(statusesForOverall),
    warnings,
    checked_at: new Date().toISOString(),
  };
}
