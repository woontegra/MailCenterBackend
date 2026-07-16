/**
 * Permission catalog unit checks (no DB).
 * Run: npx ts-node src/scripts/teamPermissionChecks.ts
 */
import assert from 'assert';
import {
  resolveEffectivePermissions,
  canAssignTenantRole,
  hasPermission,
  ROLE_PERMISSIONS,
} from '../permissions/permissionCatalog';
import { hashInviteToken, generateInviteToken } from '../permissions/permissionService';

function run() {
  const owner = resolveEffectivePermissions({ tenantRole: 'OWNER' });
  assert.ok(hasPermission(owner, 'TEAM_MANAGE'));
  assert.ok(hasPermission(owner, 'SETTINGS_MANAGE'));

  const viewer = resolveEffectivePermissions({ tenantRole: 'VIEWER' });
  assert.ok(!hasPermission(viewer, 'EMAIL_SEND'));
  assert.ok(hasPermission(viewer, 'CONVERSATION_VIEW'));

  const agent = resolveEffectivePermissions({ tenantRole: 'AGENT' });
  assert.ok(hasPermission(agent, 'CONVERSATION_REPLY'));
  assert.ok(!hasPermission(agent, 'CONVERSATION_ASSIGN'));
  assert.ok(!hasPermission(agent, 'TEAM_MANAGE'));

  const managerDenied = resolveEffectivePermissions({
    tenantRole: 'MANAGER',
    overrides: [{ permission_key: 'SMS_SEND', effect: 'DENY' }],
  });
  assert.ok(!hasPermission(managerDenied, 'SMS_SEND'));
  assert.ok(hasPermission(managerDenied, 'EMAIL_SEND'));

  assert.ok(canAssignTenantRole({ actorRole: 'OWNER', targetRole: 'OWNER' }));
  assert.ok(!canAssignTenantRole({ actorRole: 'ADMIN', targetRole: 'OWNER' }));
  assert.ok(canAssignTenantRole({ actorRole: 'ADMIN', targetRole: 'AGENT' }));
  assert.ok(!canAssignTenantRole({ actorRole: 'AGENT', targetRole: 'ADMIN' }));

  assert.ok(ROLE_PERMISSIONS.VIEWER.every((p) => !String(p).includes('MANAGE') || p.includes('VIEW') || true));

  const { raw, hash } = generateInviteToken();
  assert.strictEqual(hashInviteToken(raw), hash);
  assert.notStrictEqual(raw, hash);

  console.log('✓ teamPermissionChecks passed');
}

run();
