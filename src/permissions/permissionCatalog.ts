/**
 * Central tenant permission catalog and role → permission map.
 * Do not scatter permission string checks inside route handlers.
 */

export const PERMISSIONS = [
  'TEAM_MANAGE',
  'BRAND_MANAGE',
  'CHANNEL_MANAGE',
  'SENDER_IDENTITY_MANAGE',
  'TEMPLATE_VIEW',
  'TEMPLATE_MANAGE',
  'CONTACT_VIEW',
  'CONTACT_MANAGE',
  'CONVERSATION_VIEW',
  'CONVERSATION_REPLY',
  'CONVERSATION_ASSIGN',
  'INTERNAL_NOTE_CREATE',
  'EMAIL_SEND',
  'SMS_SEND',
  'WHATSAPP_SEND',
  'OUTBOUND_VIEW',
  'OUTBOUND_RETRY',
  'DELIVERABILITY_VIEW',
  'DELIVERABILITY_MANAGE',
  'ANALYTICS_VIEW',
  'SETTINGS_MANAGE',
  'AUTOMATION_VIEW',
  'AUTOMATION_MANAGE',
  'AUTOMATION_RUN',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const TENANT_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'AGENT', 'VIEWER'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

const ALL: Permission[] = [...PERMISSIONS];

export const ROLE_PERMISSIONS: Record<TenantRole, readonly Permission[]> = {
  OWNER: ALL,
  ADMIN: ALL,
  MANAGER: [
    'TEMPLATE_VIEW',
    'TEMPLATE_MANAGE',
    'CONTACT_VIEW',
    'CONTACT_MANAGE',
    'CONVERSATION_VIEW',
    'CONVERSATION_REPLY',
    'CONVERSATION_ASSIGN',
    'INTERNAL_NOTE_CREATE',
    'EMAIL_SEND',
    'SMS_SEND',
    'WHATSAPP_SEND',
    'OUTBOUND_VIEW',
    'OUTBOUND_RETRY',
    'DELIVERABILITY_VIEW',
    'ANALYTICS_VIEW',
    'AUTOMATION_VIEW',
    'AUTOMATION_MANAGE',
    'AUTOMATION_RUN',
  ],
  AGENT: [
    'TEMPLATE_VIEW',
    'CONTACT_VIEW',
    'CONVERSATION_VIEW',
    'CONVERSATION_REPLY',
    'INTERNAL_NOTE_CREATE',
    'EMAIL_SEND',
    'SMS_SEND',
    'WHATSAPP_SEND',
    'OUTBOUND_VIEW',
    'AUTOMATION_VIEW',
  ],
  VIEWER: [
    'TEMPLATE_VIEW',
    'CONTACT_VIEW',
    'CONVERSATION_VIEW',
    'OUTBOUND_VIEW',
    'DELIVERABILITY_VIEW',
    'ANALYTICS_VIEW',
    'AUTOMATION_VIEW',
  ],
};

export function isTenantRole(value: unknown): value is TenantRole {
  return typeof value === 'string' && TENANT_ROLES.includes(value as TenantRole);
}

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

export function permissionsForRole(role: TenantRole | null | undefined): Set<Permission> {
  if (!role || !isTenantRole(role)) return new Set();
  return new Set(ROLE_PERMISSIONS[role]);
}

export type PermissionOverride = {
  permission_key: string;
  effect: 'ALLOW' | 'DENY';
};

export function resolveEffectivePermissions(params: {
  tenantRole: TenantRole | null | undefined;
  overrides?: PermissionOverride[] | null;
}): Set<Permission> {
  const result = permissionsForRole(params.tenantRole);
  for (const o of params.overrides || []) {
    if (!isPermission(o.permission_key)) continue;
    if (o.effect === 'ALLOW') result.add(o.permission_key);
    if (o.effect === 'DENY') result.delete(o.permission_key);
  }
  return result;
}

export function hasPermission(
  effective: Set<Permission> | Permission[],
  required: Permission | Permission[]
): boolean {
  const set = effective instanceof Set ? effective : new Set(effective);
  const needed = Array.isArray(required) ? required : [required];
  return needed.every((p) => set.has(p));
}

export function roleRank(role: TenantRole): number {
  switch (role) {
    case 'OWNER':
      return 50;
    case 'ADMIN':
      return 40;
    case 'MANAGER':
      return 30;
    case 'AGENT':
      return 20;
    case 'VIEWER':
      return 10;
    default:
      return 0;
  }
}

/** OWNER can assign any role; others only assign strictly lower ranks; only OWNER assigns OWNER. */
export function canAssignTenantRole(params: {
  actorRole: TenantRole;
  targetRole: TenantRole;
}): boolean {
  if (params.targetRole === 'OWNER') return params.actorRole === 'OWNER';
  if (params.actorRole === 'OWNER') return true;
  return roleRank(params.actorRole) > roleRank(params.targetRole);
}

export function sanitizePermissionList(values: unknown): Permission[] {
  if (!Array.isArray(values)) return [];
  return values.filter(isPermission);
}
