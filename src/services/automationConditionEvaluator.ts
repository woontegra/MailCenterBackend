import {
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  ConditionField,
  ConditionOperator,
  MAX_TEXT_LEN,
  MAX_VALUE_LEN,
  clampText,
  isConditionField,
  isConditionOperator,
} from './automationConstants';

export type AutomationCondition = {
  field: ConditionField;
  operator: ConditionOperator;
  value?: unknown;
};

export type ConditionContext = Record<string, unknown>;

function normalize(value: unknown): string {
  return clampText(value, MAX_TEXT_LEN).trim().toLowerCase();
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => normalize(v)).filter(Boolean).slice(0, 50);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => normalize(v))
      .filter(Boolean)
      .slice(0, 50);
  }
  const n = normalize(value);
  return n ? [n] : [];
}

function fieldValue(ctx: ConditionContext, field: ConditionField): unknown {
  switch (field) {
    case 'brand_id':
      return ctx.brandId ?? ctx.brand_id;
    case 'channel':
      return ctx.channel;
    case 'contact_status':
      return ctx.contactStatus ?? ctx.contact_status;
    case 'preference_status':
      return ctx.preferenceStatus ?? ctx.preference_status;
    case 'conversation_status':
      return ctx.conversationStatus ?? ctx.conversation_status;
    case 'conversation_priority':
      return ctx.conversationPriority ?? ctx.conversation_priority;
    case 'from_address':
      return ctx.fromAddress ?? ctx.from_address;
    case 'to_address':
      return ctx.toAddress ?? ctx.to_address;
    case 'subject':
      return ctx.subject;
    case 'message_content':
      return ctx.messagePreview ?? ctx.message_content ?? ctx.body;
    case 'company_name':
      return ctx.companyName ?? ctx.company_name;
    case 'tag':
      return ctx.tag ?? ctx.tags;
    case 'outbound_error_code':
      return ctx.outboundErrorCode ?? ctx.outbound_error_code;
    default:
      return undefined;
  }
}

export function evaluateCondition(
  condition: AutomationCondition,
  ctx: ConditionContext
): boolean {
  if (!isConditionField(condition.field) || !isConditionOperator(condition.operator)) {
    return false;
  }
  const raw = fieldValue(ctx, condition.field);
  const op = condition.operator;
  const exists =
    raw !== undefined &&
    raw !== null &&
    !(typeof raw === 'string' && raw.trim() === '') &&
    !(Array.isArray(raw) && raw.length === 0);

  if (op === 'exists') return exists;
  if (op === 'not_exists') return !exists;

  const left = normalize(Array.isArray(raw) ? raw.join(',') : raw);
  const rightRaw = condition.value;
  const right =
    typeof rightRaw === 'string' || typeof rightRaw === 'number'
      ? clampText(rightRaw, MAX_VALUE_LEN)
      : clampText(JSON.stringify(rightRaw ?? ''), MAX_VALUE_LEN);
  const rightNorm = normalize(right);

  switch (op) {
    case 'equals':
      return left === rightNorm;
    case 'not_equals':
      return left !== rightNorm;
    case 'contains':
      return rightNorm.length > 0 && left.includes(rightNorm);
    case 'not_contains':
      return rightNorm.length === 0 || !left.includes(rightNorm);
    case 'starts_with':
      return rightNorm.length > 0 && left.startsWith(rightNorm);
    case 'ends_with':
      return rightNorm.length > 0 && left.endsWith(rightNorm);
    case 'in': {
      const list = asList(rightRaw);
      if (Array.isArray(raw)) {
        const vals = raw.map((v) => normalize(v));
        return vals.some((v) => list.includes(v));
      }
      return list.includes(left);
    }
    default:
      return false;
  }
}

export function evaluateConditions(
  conditions: AutomationCondition[] | unknown,
  ctx: ConditionContext
): { matched: boolean; details: Array<AutomationCondition & { matched: boolean }> } {
  const list = Array.isArray(conditions) ? (conditions as AutomationCondition[]) : [];
  if (list.length === 0) {
    return { matched: true, details: [] };
  }
  const details = list.slice(0, 25).map((c) => ({
    ...c,
    matched: evaluateCondition(c, ctx),
  }));
  return {
    matched: details.every((d) => d.matched),
    details,
  };
}

export function validateConditionsInput(raw: unknown): {
  ok: true;
  conditions: AutomationCondition[];
} | { ok: false; error: string } {
  if (raw == null) return { ok: true, conditions: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'conditions dizi olmalı' };
  if (raw.length > 25) return { ok: false, error: 'En fazla 25 koşul' };
  const conditions: AutomationCondition[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      return { ok: false, error: 'Geçersiz koşul' };
    }
    const field = (item as any).field;
    const operator = (item as any).operator;
    if (!isConditionField(field)) {
      return { ok: false, error: `İzin verilmeyen alan: ${field}` };
    }
    if (!isConditionOperator(operator)) {
      return { ok: false, error: `İzin verilmeyen operatör: ${operator}` };
    }
    if (!(CONDITION_FIELDS as readonly string[]).includes(field)) {
      return { ok: false, error: 'Geçersiz alan' };
    }
    if (!(CONDITION_OPERATORS as readonly string[]).includes(operator)) {
      return { ok: false, error: 'Geçersiz operatör' };
    }
    conditions.push({
      field,
      operator,
      value: (item as any).value,
    });
  }
  return { ok: true, conditions };
}
