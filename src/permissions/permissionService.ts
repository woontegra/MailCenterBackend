import crypto from 'crypto';
import { query } from '../config/database';
import {
  Permission,
  PermissionOverride,
  TenantRole,
  isTenantRole,
  resolveEffectivePermissions,
  hasPermission,
} from './permissionCatalog';

export function hashInviteToken(rawToken: string): string {
  return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
}

export function generateInviteToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString('hex');
  return { raw, hash: hashInviteToken(raw) };
}

export async function loadUserAuthContext(userId: number): Promise<{
  id: number;
  email: string;
  tenant_id: number;
  role: string;
  tenant_role: TenantRole | null;
  is_active: boolean;
  permission_version: number;
  name: string | null;
  last_login_at: Date | null;
  permissions: Permission[];
  overrides: PermissionOverride[];
} | null> {
  const userResult = await query(
    `SELECT id, email, tenant_id, role, tenant_role, COALESCE(is_active, true) AS is_active,
            COALESCE(permission_version, 1) AS permission_version, name,
            COALESCE(last_login_at, last_login) AS last_login_at
     FROM users WHERE id = $1`,
    [userId]
  );
  if (!userResult.rows[0]) return null;
  const user = userResult.rows[0];

  const overridesResult = await query(
    `SELECT permission_key, effect
     FROM user_permission_overrides
     WHERE user_id = $1 AND tenant_id = $2`,
    [user.id, user.tenant_id]
  );
  const overrides: PermissionOverride[] = overridesResult.rows.map((r: any) => ({
    permission_key: r.permission_key,
    effect: r.effect,
  }));

  const tenantRole = isTenantRole(user.tenant_role) ? user.tenant_role : null;
  const effective = resolveEffectivePermissions({ tenantRole, overrides });

  return {
    id: user.id,
    email: user.email,
    tenant_id: user.tenant_id,
    role: user.role,
    tenant_role: tenantRole,
    is_active: user.is_active !== false,
    permission_version: Number(user.permission_version) || 1,
    name: user.name || null,
    last_login_at: user.last_login_at || null,
    permissions: Array.from(effective),
    overrides,
  };
}

export async function bumpPermissionVersion(userId: number, tenantId: number): Promise<void> {
  await query(
    `UPDATE users
     SET permission_version = COALESCE(permission_version, 1) + 1
     WHERE id = $1 AND tenant_id = $2`,
    [userId, tenantId]
  );
}

export async function countOwners(tenantId: number): Promise<number> {
  const result = await query(
    `SELECT COUNT(*)::int AS c FROM users
     WHERE tenant_id = $1
       AND tenant_role = 'OWNER'
       AND COALESCE(is_active, true) = true`,
    [tenantId]
  );
  return result.rows[0]?.c || 0;
}

export async function getOwnedTenantUser(userId: number, tenantId: number) {
  const result = await query(
    `SELECT id, email, name, role, tenant_role, COALESCE(is_active, true) AS is_active,
            COALESCE(permission_version, 1) AS permission_version,
            COALESCE(last_login_at, last_login) AS last_login_at,
            created_at
     FROM users
     WHERE id = $1 AND tenant_id = $2 AND COALESCE(role, '') <> 'super_admin'`,
    [userId, tenantId]
  );
  return result.rows[0] || null;
}

export function userHasPermission(
  ctx: { permissions: Permission[] },
  required: Permission | Permission[]
): boolean {
  return hasPermission(ctx.permissions, required);
}

export async function replacePermissionOverrides(params: {
  tenantId: number;
  userId: number;
  overrides: PermissionOverride[];
}): Promise<void> {
  await query(`DELETE FROM user_permission_overrides WHERE user_id = $1 AND tenant_id = $2`, [
    params.userId,
    params.tenantId,
  ]);
  for (const o of params.overrides) {
    await query(
      `INSERT INTO user_permission_overrides (tenant_id, user_id, permission_key, effect)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, permission_key)
       DO UPDATE SET effect = EXCLUDED.effect, updated_at = CURRENT_TIMESTAMP`,
      [params.tenantId, params.userId, o.permission_key, o.effect]
    );
  }
  await bumpPermissionVersion(params.userId, params.tenantId);
}
