/**
 * Provider-agnostic SMS adapter contract.
 * Provider-specific HTTP details stay inside adapters only.
 */

export type SmsProviderName = 'NETGSM' | string;

export type SmsCredentials = {
  username: string;
  password: string;
  appname?: string | null;
};

export type SmsSendInput = {
  toE164: string;
  /** Provider-facing recipient digits (adapter may reformat) */
  toProviderNumber: string;
  message: string;
  senderHeader: string;
  encoding?: 'TR' | 'ASCII' | null;
  iysfilter?: string | null;
};

export type SmsNormalizedResponse = {
  success: boolean;
  providerMessageId?: string | null;
  code?: string | null;
  safeMessage: string;
  rawSanitized?: Record<string, unknown>;
};

export type SmsErrorClassification = {
  code: string;
  retryable: boolean;
  safeMessage: string;
};

export type SmsDeliveryStatus = {
  providerMessageId: string;
  status: string;
  safeMessage: string;
};

export type SmsConnectionTestResult = {
  ok: boolean;
  code?: string;
  safeMessage: string;
  /** Authorized sender headers when provider returns them */
  headers?: string[];
  /** true when credentials stored but live verify was not possible without sending */
  pendingFirstSend?: boolean;
};

export interface SmsProviderAdapter {
  readonly providerName: SmsProviderName;
  supportsSenderIdentity(): boolean;
  testConnection(credentials: SmsCredentials): Promise<SmsConnectionTestResult>;
  sendMessage(
    credentials: SmsCredentials,
    input: SmsSendInput
  ): Promise<SmsNormalizedResponse>;
  normalizeProviderResponse(raw: unknown): SmsNormalizedResponse;
  classifyError(error: unknown): SmsErrorClassification;
  getDeliveryStatus?(
    credentials: SmsCredentials,
    providerMessageId: string
  ): Promise<SmsDeliveryStatus>;
}
