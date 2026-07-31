/**
 * Meta WhatsApp Cloud API adapter.
 * Official docs (developers.facebook.com):
 * - Send: POST https://graph.facebook.com/{version}/{PHONE_NUMBER_ID}/messages
 * - Phone lookup (test): GET https://graph.facebook.com/{version}/{PHONE_NUMBER_ID}
 * - Webhook verify: GET hub.mode / hub.challenge / hub.verify_token
 * - Signature: X-Hub-Signature-256 = sha256=<HMAC-SHA256(rawBody, app_secret)>
 * - Free-form text only inside 24h customer service window after user message
 * - Template messages for outbound outside that window
 */

import * as crypto from 'crypto';
import {
  WhatsAppConnectionConfig,
  WhatsAppConnectionTestResult,
  WhatsAppCredentials,
  WhatsAppErrorClassification,
  WhatsAppNormalizedResponse,
  WhatsAppParsedWebhookEvent,
  WhatsAppProviderAdapter,
  WhatsAppTemplateSendInput,
  WhatsAppTextSendInput,
  WhatsAppWebhookVerifyInput,
} from '../WhatsAppProviderAdapter';

export type MetaFetch = typeof fetch;

const DEFAULT_API_VERSION = 'v23.0';

function graphBase(apiVersion: string): string {
  const v = String(apiVersion || DEFAULT_API_VERSION).replace(/^\/*/, '');
  return `https://graph.facebook.com/${v.startsWith('v') ? v : `v${v}`}`;
}

function authHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
}

function safeErrorFromGraph(data: any, status?: number): WhatsAppErrorClassification {
  const err = data?.error || data;
  const code = String(err?.code || err?.error_subcode || status || 'WA_SEND_FAILED');
  const msg = String(err?.message || err?.error_user_msg || 'WhatsApp gönderimi başarısız')
    .replace(/EAA[A-Za-z0-9]+/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 400);

  // Meta rate limits / transient
  const retryableCodes = new Set([
    '1',
    '2',
    '4',
    '17',
    '32',
    '613',
    '80007',
    '130429',
    '131048',
    '131056',
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'FETCH_ERROR',
  ]);
  // Permanent-ish: invalid token, permission, template, recipient
  const permanentCodes = new Set([
    '10',
    '100',
    '190',
    '200',
    '368',
    '131009',
    '131021',
    '131026',
    '131047',
    '131051',
    '132000',
    '132001',
    '132005',
    '132007',
    '132012',
    '132015',
    '132016',
    '133010',
  ]);

  if (permanentCodes.has(code)) {
    return { code, retryable: false, safeMessage: sanitizeUserMessage(msg) };
  }
  if (retryableCodes.has(code) || Number(status) === 429 || Number(status) >= 500) {
    return { code, retryable: true, safeMessage: sanitizeUserMessage(msg) };
  }
  return {
    code: code.slice(0, 100),
    retryable: true,
    safeMessage: sanitizeUserMessage(msg),
  };
}

function sanitizeUserMessage(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes('access token') || lower.includes('oauth') || lower.includes('session')) {
    return 'WhatsApp kimlik doğrulama hatası';
  }
  if (lower.includes('rate') || lower.includes('limit') || lower.includes('throttle')) {
    return 'WhatsApp hız sınırı aşıldı';
  }
  return msg.slice(0, 300) || 'WhatsApp işlemi başarısız';
}

/** UI-safe send failure: keeps Meta message + code, never tokens. */
export function formatWhatsAppSendFailureMessage(data: any, status?: number): string {
  const err = data?.error || data || {};
  const code = err?.code != null ? err.code : status != null ? status : null;
  const raw = String(err?.message || err?.error_user_msg || 'bilinmeyen Meta hatası')
    .replace(/EAA[A-Za-z0-9]+/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 300);
  const safe = sanitizeUserMessage(raw);
  const codePart = code != null ? ` (kod: ${code})` : '';
  return `WhatsApp mesajı gönderilemedi: ${safe}${codePart}`;
}

function logWhatsAppMessagesGraph(params: {
  ok: boolean;
  httpStatus: number;
  phoneNumberId: string;
  to?: string | null;
  templateName?: string | null;
  languageCode?: string | null;
  messageId?: string | null;
  data?: any;
}): void {
  if (params.ok) {
    console.info('[meta-graph] messages POST ok', {
      httpStatus: params.httpStatus,
      phoneNumberId: params.phoneNumberId,
      to: params.to || null,
      templateName: params.templateName || null,
      languageCode: params.languageCode || null,
      messageId: params.messageId || null,
    });
    return;
  }
  const err = params.data?.error || {};
  console.error('[meta-graph] messages POST failed', {
    httpStatus: params.httpStatus,
    phoneNumberId: params.phoneNumberId,
    to: params.to || null,
    templateName: params.templateName || null,
    languageCode: params.languageCode || null,
    message: err?.message != null ? String(err.message).slice(0, 300) : null,
    type: err?.type != null ? String(err.type) : null,
    code: err?.code != null ? err.code : null,
    errorSubcode: err?.error_subcode != null ? err.error_subcode : null,
    fbtraceId: err?.fbtrace_id != null ? String(err.fbtrace_id) : null,
  });
}

export class MetaWhatsAppCloudAdapter implements WhatsAppProviderAdapter {
  readonly providerName = 'META_WHATSAPP_CLOUD';
  private fetchImpl: MetaFetch;

  constructor(fetchImpl: MetaFetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  supportsSenderIdentity(): boolean {
    return true;
  }

  normalizeProviderResponse(raw: unknown): WhatsAppNormalizedResponse {
    const data = (raw && typeof raw === 'object' ? raw : {}) as any;
    if (data.error) {
      const classified = safeErrorFromGraph(data);
      return {
        success: false,
        code: classified.code,
        safeMessage: classified.safeMessage,
      };
    }
    const msg = Array.isArray(data.messages) ? data.messages[0] : null;
    const id = msg?.id != null ? String(msg.id) : null;
    return {
      success: Boolean(id),
      providerMessageId: id,
      code: id ? 'OK' : 'NO_MESSAGE_ID',
      safeMessage: id ? 'WhatsApp mesajı kabul edildi' : 'WhatsApp yanıtında mesaj kimliği yok',
    };
  }

  classifyError(error: unknown): WhatsAppErrorClassification {
    const err = error as any;
    if (err?.graphError) return safeErrorFromGraph(err.graphError, err.status);
    if (err?.code) {
      return safeErrorFromGraph({ error: { code: err.code, message: err.message } }, err.status);
    }
    return safeErrorFromGraph(
      { error: { code: err?.code || 'FETCH_ERROR', message: err?.message } },
      err?.status
    );
  }

  async testConnection(
    credentials: WhatsAppCredentials,
    config: WhatsAppConnectionConfig
  ): Promise<WhatsAppConnectionTestResult> {
    try {
      const url = `${graphBase(config.apiVersion)}/${encodeURIComponent(config.phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`;
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: authHeaders(credentials.accessToken),
      });
      let data: any = null;
      try {
        data = await response.json();
      } catch {
        return { ok: false, code: 'PARSE_ERROR', safeMessage: 'Sağlayıcı yanıtı okunamadı' };
      }

      if (!response.ok || data?.error) {
        const classified = safeErrorFromGraph(data, response.status);
        return {
          ok: false,
          code: classified.code,
          safeMessage: classified.safeMessage,
        };
      }

      return {
        ok: true,
        code: 'OK',
        safeMessage: 'Meta WhatsApp telefon numarası doğrulandı',
        displayPhoneNumber: data.display_phone_number || null,
      };
    } catch (error: any) {
      return {
        ok: false,
        code: error?.code || 'FETCH_ERROR',
        safeMessage: 'WhatsApp bağlantı testi başarısız',
      };
    }
  }

  async sendTextMessage(
    credentials: WhatsAppCredentials,
    input: WhatsAppTextSendInput
  ): Promise<WhatsAppNormalizedResponse> {
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: input.toProviderNumber,
      type: 'text',
      text: { preview_url: false, body: input.body },
    };
    return this.postMessages(credentials, input.apiVersion, input.phoneNumberId, body);
  }

  async sendTemplateMessage(
    credentials: WhatsAppCredentials,
    input: WhatsAppTemplateSendInput
  ): Promise<WhatsAppNormalizedResponse> {
    const template: Record<string, unknown> = {
      name: input.templateName,
      language: { code: input.languageCode },
    };
    if (input.components && Array.isArray(input.components) && input.components.length > 0) {
      template.components = input.components;
    }
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: input.toProviderNumber,
      type: 'template',
      template,
    };
    return this.postMessages(credentials, input.apiVersion, input.phoneNumberId, body, {
      to: input.toProviderNumber,
      templateName: input.templateName,
      languageCode: input.languageCode,
    });
  }

  private async postMessages(
    credentials: WhatsAppCredentials,
    apiVersion: string,
    phoneNumberId: string,
    body: Record<string, unknown>,
    meta?: { to?: string; templateName?: string; languageCode?: string }
  ): Promise<WhatsAppNormalizedResponse> {
    try {
      const url = `${graphBase(apiVersion)}/${encodeURIComponent(phoneNumberId)}/messages`;
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: authHeaders(credentials.accessToken),
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
      if (!normalized.success || !normalized.providerMessageId) {
        const failMsg = data?.error
          ? formatWhatsAppSendFailureMessage(data, response.status)
          : normalized.safeMessage || 'WhatsApp yanıtında mesaj kimliği yok';
        logWhatsAppMessagesGraph({
          ok: false,
          httpStatus: response.status,
          phoneNumberId,
          to: meta?.to,
          templateName: meta?.templateName,
          languageCode: meta?.languageCode,
          data,
        });
        throw Object.assign(new Error(failMsg), {
          code: normalized.code || data?.error?.code || 'WA_SEND_FAILED',
          status: response.status,
          graphError: data,
        });
      }

      logWhatsAppMessagesGraph({
        ok: true,
        httpStatus: response.status,
        phoneNumberId,
        to: meta?.to,
        templateName: meta?.templateName,
        languageCode: meta?.languageCode,
        messageId: normalized.providerMessageId,
      });
      return normalized;
    } catch (error) {
      if ((error as any)?.code) throw error;
      throw Object.assign(new Error('WhatsApp gönderimi başarısız'), {
        code: 'FETCH_ERROR',
        cause: error,
      });
    }
  }

  verifyWebhook(input: WhatsAppWebhookVerifyInput): { ok: boolean; challenge?: string } {
    if (input.mode !== 'subscribe') return { ok: false };
    if (!input.verifyToken || input.verifyToken !== input.expectedVerifyToken) {
      return { ok: false };
    }
    if (input.challenge == null || input.challenge === '') return { ok: false };
    return { ok: true, challenge: String(input.challenge) };
  }

  validateWebhookSignature(params: {
    appSecret: string;
    rawBody: Buffer | string;
    signatureHeader: string | null | undefined;
  }): boolean {
    const header = String(params.signatureHeader || '');
    if (!header.startsWith('sha256=')) return false;
    const expectedHex = header.slice('sha256='.length).trim();
    if (!expectedHex || !params.appSecret) return false;

    const raw =
      typeof params.rawBody === 'string' ? Buffer.from(params.rawBody) : params.rawBody;
    const hmac = crypto.createHmac('sha256', params.appSecret).update(raw).digest('hex');

    try {
      const a = Buffer.from(hmac, 'hex');
      const b = Buffer.from(expectedHex, 'hex');
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  parseWebhook(payload: unknown): WhatsAppParsedWebhookEvent[] {
    const events: WhatsAppParsedWebhookEvent[] = [];
    const root = payload as any;
    if (!root || root.object !== 'whatsapp_business_account') return events;

    const entries = Array.isArray(root.entry) ? root.entry : [];
    for (const entry of entries) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const change of changes) {
        if (change?.field !== 'messages') continue;
        const value = change.value || {};
        const phoneNumberId = String(value?.metadata?.phone_number_id || '');
        if (!phoneNumberId) continue;

        const contacts = Array.isArray(value.contacts) ? value.contacts : [];
        const contactName = contacts[0]?.profile?.name || null;

        const statuses = Array.isArray(value.statuses) ? value.statuses : [];
        for (const st of statuses) {
          const statusRaw = String(st.status || '').toLowerCase();
          if (!['sent', 'delivered', 'read', 'failed'].includes(statusRaw)) continue;
          const err = Array.isArray(st.errors) ? st.errors[0] : null;
          events.push({
            kind: 'status',
            phoneNumberId,
            providerMessageId: String(st.id || ''),
            status: statusRaw as any,
            recipientId: st.recipient_id ? String(st.recipient_id) : null,
            timestamp: st.timestamp ? String(st.timestamp) : null,
            errorCode: err?.code != null ? String(err.code) : null,
            errorTitle: err?.title ? String(err.title).slice(0, 200) : null,
          });
        }

        const messages = Array.isArray(value.messages) ? value.messages : [];
        for (const msg of messages) {
          const type = String(msg.type || 'text');
          let textBody: string | null = null;
          let mediaMetadata: Record<string, unknown> | null = null;

          if (type === 'text') {
            textBody = msg.text?.body != null ? String(msg.text.body) : null;
          } else if (['image', 'audio', 'video', 'document', 'sticker'].includes(type)) {
            const media = msg[type] || {};
            mediaMetadata = {
              media_type: type,
              mime_type: media.mime_type || null,
              sha256: media.sha256 || null,
              // Do not persist provider download URLs that may embed tokens
              has_media: true,
            };
            textBody = 'Medya mesajı';
          } else if (type === 'location') {
            textBody = 'Konum mesajı';
            mediaMetadata = { media_type: 'location' };
          } else if (type === 'contacts') {
            textBody = 'Kişi kartı';
            mediaMetadata = { media_type: 'contacts' };
          } else if (type === 'interactive') {
            textBody = msg.interactive?.button_reply?.title
              || msg.interactive?.list_reply?.title
              || 'Etkileşimli yanıt';
          } else {
            textBody = `Mesaj (${type})`;
          }

          events.push({
            kind: 'inbound',
            phoneNumberId,
            providerMessageId: String(msg.id || ''),
            from: String(msg.from || ''),
            messageType: type,
            textBody,
            timestamp: msg.timestamp ? String(msg.timestamp) : null,
            mediaMetadata,
            contactName,
          });
        }
      }
    }

    return events.filter((e) => e.providerMessageId);
  }
}

/** E.164 → Meta `to` digits without + */
export function e164ToWhatsAppNumber(e164: string): string {
  return String(e164 || '').replace(/\D/g, '');
}

export { DEFAULT_API_VERSION };
