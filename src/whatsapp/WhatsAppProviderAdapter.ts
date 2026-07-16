/**
 * Provider-agnostic WhatsApp adapter contract.
 */

export type WhatsAppProviderName = 'META_WHATSAPP_CLOUD' | string;

export type WhatsAppCredentials = {
  accessToken: string;
  appSecret: string;
  webhookVerifyToken: string;
};

export type WhatsAppConnectionConfig = {
  wabaId: string;
  phoneNumberId: string;
  businessPhoneNumber?: string | null;
  apiVersion: string;
};

export type WhatsAppTextSendInput = {
  toE164: string;
  toProviderNumber: string;
  body: string;
  phoneNumberId: string;
  apiVersion: string;
};

export type WhatsAppTemplateSendInput = {
  toE164: string;
  toProviderNumber: string;
  phoneNumberId: string;
  apiVersion: string;
  templateName: string;
  languageCode: string;
  components?: unknown[];
};

export type WhatsAppNormalizedResponse = {
  success: boolean;
  providerMessageId?: string | null;
  code?: string | null;
  safeMessage: string;
};

export type WhatsAppErrorClassification = {
  code: string;
  retryable: boolean;
  safeMessage: string;
};

export type WhatsAppConnectionTestResult = {
  ok: boolean;
  code?: string;
  safeMessage: string;
  displayPhoneNumber?: string | null;
  pendingFirstSend?: boolean;
};

export type WhatsAppWebhookVerifyInput = {
  mode?: string | null;
  challenge?: string | null;
  verifyToken?: string | null;
  expectedVerifyToken: string;
};

export type WhatsAppParsedWebhookEvent =
  | {
      kind: 'status';
      phoneNumberId: string;
      providerMessageId: string;
      status: 'sent' | 'delivered' | 'read' | 'failed';
      recipientId?: string | null;
      timestamp?: string | null;
      errorCode?: string | null;
      errorTitle?: string | null;
    }
  | {
      kind: 'inbound';
      phoneNumberId: string;
      providerMessageId: string;
      from: string;
      messageType: string;
      textBody?: string | null;
      timestamp?: string | null;
      mediaMetadata?: Record<string, unknown> | null;
      contactName?: string | null;
    };

export interface WhatsAppProviderAdapter {
  readonly providerName: WhatsAppProviderName;
  supportsSenderIdentity(): boolean;
  testConnection(
    credentials: WhatsAppCredentials,
    config: WhatsAppConnectionConfig
  ): Promise<WhatsAppConnectionTestResult>;
  sendTextMessage(
    credentials: WhatsAppCredentials,
    input: WhatsAppTextSendInput
  ): Promise<WhatsAppNormalizedResponse>;
  sendTemplateMessage(
    credentials: WhatsAppCredentials,
    input: WhatsAppTemplateSendInput
  ): Promise<WhatsAppNormalizedResponse>;
  normalizeProviderResponse(raw: unknown): WhatsAppNormalizedResponse;
  classifyError(error: unknown): WhatsAppErrorClassification;
  verifyWebhook(input: WhatsAppWebhookVerifyInput): { ok: boolean; challenge?: string };
  /**
   * Validate X-Hub-Signature-256 (sha256=hex) against raw body + app secret.
   */
  validateWebhookSignature(params: {
    appSecret: string;
    rawBody: Buffer | string;
    signatureHeader: string | null | undefined;
  }): boolean;
  parseWebhook(payload: unknown): WhatsAppParsedWebhookEvent[];
}
