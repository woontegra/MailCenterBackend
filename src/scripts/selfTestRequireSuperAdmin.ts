/**
 * Middleware unit checks for requireSuperAdmin (no HTTP server required).
 * Run: npx ts-node src/scripts/selfTestRequireSuperAdmin.ts
 */
import { Response } from 'express';
import { requireSuperAdmin, AuthRequest } from '../middleware/auth';

function mockRes() {
  const state: { statusCode?: number; body?: any } = {};
  const res = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(body: any) {
      state.body = body;
      return this;
    },
  } as unknown as Response;
  return { res, state };
}

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed += 1;
  } else {
    console.log('OK:', msg);
  }
}

function run(role: string | undefined) {
  const { res, state } = mockRes();
  let nextCalled = false;
  const req = {
    user: role
      ? {
          userId: 1,
          email: 'x@y.com',
          tenantId: 1,
          role,
          tenantRole: 'OWNER',
          permissions: [],
          permissionVersion: 1,
        }
      : undefined,
  } as AuthRequest;
  requireSuperAdmin(req, res, () => {
    nextCalled = true;
  });
  return { state, nextCalled };
}

const denied = run('user');
assert(denied.state.statusCode === 403, 'normal user gets 403');
assert(denied.state.body?.error === 'Forbidden', '403 body is Forbidden without details');
assert(!denied.nextCalled, 'normal user does not proceed');

const adminDenied = run('admin');
assert(adminDenied.state.statusCode === 403, 'tenant admin role gets 403 (not platform SUPER_ADMIN)');
assert(!adminDenied.nextCalled, 'tenant admin does not proceed');

const allowed = run('super_admin');
assert(allowed.nextCalled, 'super_admin proceeds');
assert(allowed.state.statusCode === undefined, 'super_admin has no error status');

const noUser = run(undefined);
assert(noUser.state.statusCode === 403, 'missing user gets 403');

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nrequireSuperAdmin checks passed');
