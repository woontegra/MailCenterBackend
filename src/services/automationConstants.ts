export const AUTOMATION_TRIGGERS = [
  'CONTACT_CREATED',
  'CONTACT_UPDATED',
  'INBOUND_EMAIL_RECEIVED',
  'INBOUND_WHATSAPP_RECEIVED',
  'CONVERSATION_CREATED',
  'CONVERSATION_STATUS_CHANGED',
  'OUTBOUND_MESSAGE_FAILED',
  'MANUAL',
] as const;

export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

export const AUTOMATION_STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'] as const;
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

export const AUTOMATION_ACTION_TYPES = [
  'SEND_EMAIL',
  'SEND_SMS',
  'SEND_WHATSAPP',
  'ASSIGN_CONVERSATION',
  'SET_CONVERSATION_STATUS',
  'SET_CONVERSATION_PRIORITY',
  'CREATE_INTERNAL_NOTE',
  'ADD_CONTACT_BRAND',
  'UPDATE_COMMUNICATION_PREFERENCE',
] as const;

export type AutomationActionType = (typeof AUTOMATION_ACTION_TYPES)[number];

export const CONDITION_FIELDS = [
  'brand_id',
  'channel',
  'contact_status',
  'preference_status',
  'conversation_status',
  'conversation_priority',
  'from_address',
  'to_address',
  'subject',
  'message_content',
  'company_name',
  'tag',
  'outbound_error_code',
] as const;

export type ConditionField = (typeof CONDITION_FIELDS)[number];

export const CONDITION_OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'exists',
  'not_exists',
  'in',
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export const MAX_CHAIN_DEPTH = 3;
export const MAX_ACTIONS_PER_RULE = 20;
export const MAX_DELAY_SECONDS = 86_400;
export const MAX_CONDITIONS = 25;
export const MAX_TEXT_LEN = 2_000;
export const MAX_VALUE_LEN = 500;
export const MAX_PAYLOAD_STR = 400;

export function isAutomationTrigger(v: unknown): v is AutomationTrigger {
  return typeof v === 'string' && (AUTOMATION_TRIGGERS as readonly string[]).includes(v);
}

export function isAutomationActionType(v: unknown): v is AutomationActionType {
  return typeof v === 'string' && (AUTOMATION_ACTION_TYPES as readonly string[]).includes(v);
}

export function isConditionOperator(v: unknown): v is ConditionOperator {
  return typeof v === 'string' && (CONDITION_OPERATORS as readonly string[]).includes(v);
}

export function isConditionField(v: unknown): v is ConditionField {
  return typeof v === 'string' && (CONDITION_FIELDS as readonly string[]).includes(v);
}

export function clampText(value: unknown, max = MAX_TEXT_LEN): string {
  return String(value ?? '').slice(0, max);
}

export function sanitizePayload(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const allow = [
    'contactId',
    'brandId',
    'channel',
    'conversationId',
    'mailId',
    'inboundMessageId',
    'outboundMessageId',
    'fromAddress',
    'toAddress',
    'subject',
    'messagePreview',
    'companyName',
    'contactStatus',
    'preferenceStatus',
    'conversationStatus',
    'conversationPriority',
    'outboundErrorCode',
    'tag',
    'tags',
    'assignedUserId',
    'status',
    'priority',
    'originAutomationId',
    'chainDepth',
    'manual',
  ];
  for (const key of allow) {
    if (input[key] === undefined) continue;
    const v = input[key];
    if (typeof v === 'string') out[key] = v.slice(0, MAX_PAYLOAD_STR);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[key] = v;
    else if (Array.isArray(v)) {
      out[key] = v
        .slice(0, 20)
        .map((x) => (typeof x === 'string' ? x.slice(0, 80) : x));
    }
  }
  return out;
}
