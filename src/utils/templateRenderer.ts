export type TemplateVariableDef =
  | string
  | {
      name: string;
      required?: boolean;
      label?: string;
    };

export type RenderTemplateInput = {
  subject?: string | null;
  htmlContent?: string | null;
  plainTextContent?: string | null;
  variables?: TemplateVariableDef[] | null;
  values?: Record<string, unknown> | null;
};

export type RenderTemplateResult = {
  subject: string;
  htmlContent: string;
  plainTextContent: string;
  missingRequired: string[];
  unknownInContent: string[];
  declaredVariables: string[];
  usedVariables: string[];
};

const VAR_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function normalizeVariableDefs(
  variables: TemplateVariableDef[] | null | undefined
): { name: string; required: boolean; label?: string }[] {
  if (!Array.isArray(variables)) return [];

  const result: { name: string; required: boolean; label?: string }[] = [];

  for (const item of variables) {
    if (typeof item === 'string') {
      const name = item.trim();
      if (name) result.push({ name, required: true });
      continue;
    }
    if (item && typeof item === 'object' && typeof item.name === 'string') {
      const name = item.name.trim();
      if (!name) continue;
      result.push({
        name,
        required: item.required !== false,
        label: item.label,
      });
    }
  }

  return result;
}

export function extractTemplateVariables(...parts: Array<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    const re = new RegExp(VAR_PATTERN.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(part)) !== null) {
      found.add(match[1]);
    }
  }
  return Array.from(found);
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function substitute(
  template: string,
  values: Record<string, string>,
  options: { escape: boolean }
): string {
  return template.replace(VAR_PATTERN, (_full, name: string) => {
    const raw = values[name] ?? '';
    return options.escape ? escapeHtml(raw) : raw;
  });
}

export function renderTemplateContent(input: RenderTemplateInput): RenderTemplateResult {
  const defs = normalizeVariableDefs(input.variables);
  const declaredVariables = defs.map((d) => d.name);
  const requiredNames = defs.filter((d) => d.required).map((d) => d.name);

  const subject = input.subject || '';
  const htmlContent = input.htmlContent || '';
  const plainTextContent = input.plainTextContent || '';

  const usedVariables = extractTemplateVariables(subject, htmlContent, plainTextContent);
  const valueMap: Record<string, string> = {};
  const rawValues = input.values || {};

  for (const [key, value] of Object.entries(rawValues)) {
    valueMap[key] = stringifyValue(value);
  }

  const missingRequired = requiredNames.filter((name) => {
    const value = valueMap[name];
    return value === undefined || value.trim() === '';
  });

  const unknownInContent = usedVariables.filter((name) => !declaredVariables.includes(name));

  return {
    subject: substitute(subject, valueMap, { escape: false }),
    htmlContent: substitute(htmlContent, valueMap, { escape: true }),
    plainTextContent: substitute(plainTextContent, valueMap, { escape: false }),
    missingRequired,
    unknownInContent,
    declaredVariables,
    usedVariables,
  };
}

export function assertNoHeaderInjection(value: string, fieldName: string): void {
  if (/[\r\n]/.test(value)) {
    throw Object.assign(new Error(`${fieldName} contains invalid characters`), {
      code: 'HEADER_INJECTION',
      field: fieldName,
    });
  }
}

const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export function parseAddressList(input: unknown, fieldName: string): string[] {
  if (input === null || input === undefined || input === '') return [];

  const raw = Array.isArray(input) ? input.join(',') : String(input);
  assertNoHeaderInjection(raw, fieldName);

  return raw
    .split(/[,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function validateEmailAddresses(addresses: string[], fieldName: string): void {
  for (const address of addresses) {
    assertNoHeaderInjection(address, fieldName);
    if (!EMAIL_RE.test(address)) {
      throw Object.assign(new Error(`Invalid email in ${fieldName}`), {
        code: 'INVALID_EMAIL',
        field: fieldName,
      });
    }
  }
}

export const MAX_RECIPIENTS_PER_FIELD = 25;
export const MAX_RECIPIENTS_TOTAL = 50;
