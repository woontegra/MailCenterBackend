/**
 * Netgsm REST v2 adapter.
 * Endpoints and auth match the official Netgsm Node SDK (@netgsm/sms):
 * - Base: https://api.netgsm.com.tr
 * - Auth: HTTP Basic (username:password)
 * - Send: POST /sms/rest/v2/send
 * - Headers: GET /sms/rest/v2/msgheader
 * - Report: POST /sms/rest/v2/report
 * Success code: "00"
 */

import {
  SmsConnectionTestResult,
  SmsCredentials,
  SmsDeliveryStatus,
  SmsErrorClassification,
  SmsNormalizedResponse,
  SmsProviderAdapter,
  SmsSendInput,
} from '../SmsProviderAdapter';

const BASE_URL = 'https://api.netgsm.com.tr';

/** Official SendSmsErrorCode values from @netgsm/sms enums */
const SAFE_MESSAGES: Record<string, string> = {
  '00': 'İşlem başarılı',
  '20': 'Mesaj metni geçersiz veya karakter limiti aşıldı',
  '30': 'Kimlik doğrulama başarısız veya API erişimi yok',
  '40': 'Gönderici başlığı sistemde tanımlı değil',
  '50': 'İYS kontrollü gönderim bu hesapta yapılamıyor',
  '51': 'İYS marka bilgisi bulunamadı',
  '70': 'Geçersiz istek parametreleri',
  '80': 'Gönderim hız sınırı aşıldı',
  '85': 'Aynı numaraya kısa sürede çok fazla görev',
  '100': 'Sağlayıcı sistem hatası',
  '101': 'Sağlayıcı sistem hatası',
  '5000': 'Bilinmeyen sağlayıcı hatası',
};

const PERMANENT_CODES = new Set(['20', '30', '40', '50', '51', '70']);
const RETRYABLE_CODES = new Set(['80', '85', '100', '101', '5000']);

export type NetgsmFetch = typeof fetch;

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function safeCodeMessage(code: string | null | undefined): string {
  if (!code) return 'SMS işlemi başarısız';
  return SAFE_MESSAGES[code] || 'SMS işlemi başarısız';
}

function redactSecrets(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value
      .replace(/enc:v1:[^\s]+/gi, '[redacted]')
      .replace(/("password"\s*:\s*")[^"]*"/gi, '$1[redacted]"')
      .replace(/(password[=:]\s*)\S+/gi, '$1[redacted]');
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/pass|secret|token|authorization/i.test(k)) {
        out[k] = '[redacted]';
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out;
  }
  return value;
}

export class NetgsmAdapter implements SmsProviderAdapter {
  readonly providerName = 'NETGSM';
  private fetchImpl: NetgsmFetch;

  constructor(fetchImpl: NetgsmFetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  supportsSenderIdentity(): boolean {
    return true;
  }

  normalizeProviderResponse(raw: unknown): SmsNormalizedResponse {
    const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const code = data.code != null ? String(data.code) : null;
    const success = code === '00';
    const jobid =
      data.jobid != null
        ? String(data.jobid)
        : data.bulkid != null
          ? String(data.bulkid)
          : null;

    return {
      success,
      providerMessageId: jobid,
      code,
      safeMessage: success ? 'SMS kuyruğa alındı' : safeCodeMessage(code),
      rawSanitized: redactSecrets(data) as Record<string, unknown>,
    };
  }

  classifyError(error: unknown): SmsErrorClassification {
    const err = error as any;
    const code = String(err?.code || err?.providerCode || 'SEND_FAILED');
    const status = Number(err?.status || err?.httpStatus || 0);

    if (PERMANENT_CODES.has(code)) {
      return { code, retryable: false, safeMessage: safeCodeMessage(code) };
    }
    if (RETRYABLE_CODES.has(code) || code === '80' || code === '85') {
      return { code, retryable: true, safeMessage: safeCodeMessage(code) };
    }
    if (status === 429 || status >= 500) {
      return {
        code: code || `HTTP_${status}`,
        retryable: true,
        safeMessage: 'Geçici sağlayıcı hatası',
      };
    }
    if (
      ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'FETCH_ERROR'].includes(code) ||
      /timeout|network|econn/i.test(String(err?.message || ''))
    ) {
      return {
        code: code.slice(0, 100),
        retryable: true,
        safeMessage: 'Ağ hatası, yeniden denenecek',
      };
    }

    return {
      code: code.slice(0, 100),
      retryable: !PERMANENT_CODES.has(code),
      safeMessage: safeCodeMessage(code) || 'SMS gönderimi başarısız',
    };
  }

  async testConnection(credentials: SmsCredentials): Promise<SmsConnectionTestResult> {
    try {
      const url = new URL(`${BASE_URL}/sms/rest/v2/msgheader`);
      if (credentials.appname) {
        url.searchParams.set('appname', credentials.appname);
      }

      const response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: basicAuthHeader(credentials.username, credentials.password),
        },
      });

      let data: any = null;
      try {
        data = await response.json();
      } catch {
        return {
          ok: false,
          code: 'PARSE_ERROR',
          safeMessage: 'Sağlayıcı yanıtı okunamadı',
        };
      }

      const code = data?.code != null ? String(data.code) : null;
      if ((response.status === 200 || response.status === 406) && code === '00') {
        const headers = extractHeaders(data);
        return {
          ok: true,
          code: '00',
          safeMessage: 'Netgsm hesabı doğrulandı',
          headers,
        };
      }

      if (code === '30' || response.status === 401 || response.status === 403) {
        return {
          ok: false,
          code: code || String(response.status),
          safeMessage: safeCodeMessage('30'),
        };
      }

      return {
        ok: false,
        code: code || String(response.status),
        safeMessage: safeCodeMessage(code) || 'Bağlantı doğrulanamadı',
      };
    } catch (error: any) {
      const classified = this.classifyError({
        code: error?.code || 'FETCH_ERROR',
        message: error?.message,
      });
      return {
        ok: false,
        code: classified.code,
        safeMessage: classified.safeMessage,
      };
    }
  }

  async sendMessage(
    credentials: SmsCredentials,
    input: SmsSendInput
  ): Promise<SmsNormalizedResponse> {
    try {
      const body: Record<string, unknown> = {
        msgheader: input.senderHeader,
        messages: [{ msg: input.message, no: input.toProviderNumber }],
      };
      if (input.encoding) body.encoding = input.encoding;
      if (input.iysfilter != null && input.iysfilter !== '') {
        body.iysfilter = input.iysfilter;
      }
      if (credentials.appname) body.appname = credentials.appname;

      const response = await this.fetchImpl(`${BASE_URL}/sms/rest/v2/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: basicAuthHeader(credentials.username, credentials.password),
        },
        body: JSON.stringify(body),
      });

      let data: any = null;
      try {
        data = await response.json();
      } catch {
        throw Object.assign(new Error('Sağlayıcı yanıtı okunamadı'), {
          code: 'PARSE_ERROR',
          status: response.status,
        });
      }

      const normalized = this.normalizeProviderResponse(data);
      if (!normalized.success) {
        throw Object.assign(new Error(normalized.safeMessage), {
          code: normalized.code || 'SEND_FAILED',
          status: response.status,
          providerCode: normalized.code,
        });
      }
      return normalized;
    } catch (error) {
      if ((error as any)?.code) throw error;
      throw Object.assign(new Error('SMS gönderimi başarısız'), {
        code: 'FETCH_ERROR',
        cause: error,
      });
    }
  }

  async getDeliveryStatus(
    credentials: SmsCredentials,
    providerMessageId: string
  ): Promise<SmsDeliveryStatus> {
    const response = await this.fetchImpl(`${BASE_URL}/sms/rest/v2/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: basicAuthHeader(credentials.username, credentials.password),
      },
      body: JSON.stringify({
        jobids: [providerMessageId],
        ...(credentials.appname ? { appname: credentials.appname } : {}),
      }),
    });

    let data: any = null;
    try {
      data = await response.json();
    } catch {
      return {
        providerMessageId,
        status: 'UNKNOWN',
        safeMessage: 'Rapor okunamadı',
      };
    }

    const code = data?.code != null ? String(data.code) : null;
    return {
      providerMessageId,
      status: code === '00' ? 'REPORTED' : code || 'UNKNOWN',
      safeMessage: safeCodeMessage(code),
    };
  }
}

function extractHeaders(data: any): string[] {
  const candidates = data?.msgheader || data?.msgheaders || data?.headers || data?.data;
  if (Array.isArray(candidates)) {
    return candidates
      .map((item) => {
        if (typeof item === 'string') return item.trim();
        if (item && typeof item === 'object') {
          return String(item.msgheader || item.header || item.name || '').trim();
        }
        return '';
      })
      .filter(Boolean);
  }
  if (typeof candidates === 'string' && candidates.trim()) {
    return [candidates.trim()];
  }
  return [];
}

/** Convert E.164 to Netgsm `no` digits (no leading +). */
export function e164ToNetgsmNumber(e164: string): string {
  return String(e164 || '').replace(/\D/g, '');
}
