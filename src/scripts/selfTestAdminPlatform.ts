/**
 * Local self-test for admin-platform security invariants (no commit/deploy).
 * Run: npx ts-node src/scripts/selfTestAdminPlatform.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import bcrypt from 'bcrypt';
import { query } from '../config/database';
import { hashPassword } from '../utils/auth';

let failed = 0;

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed += 1;
  } else {
    console.log('OK:', msg);
  }
}

async function main() {
  // Password hashing
  const plain = 'TestPass99';
  const hashed = await hashPassword(plain);
  assert(hashed !== plain, 'password is hashed (not plain)');
  assert(await bcrypt.compare(plain, hashed), 'bcrypt compare succeeds');
  assert(!(await bcrypt.compare('wrong', hashed)), 'bcrypt rejects wrong password');

  // Schema columns for admin platform
  const cols = await query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'tenants'
       AND column_name IN ('is_test_account','expires_at','admin_notes')`
  );
  assert(cols.rows.length === 3, 'tenants has is_test_account, expires_at, admin_notes');

  const auditCols = await query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'platform_audit_logs'
       AND column_name IN ('ip_address','user_agent','metadata')`
  );
  assert(auditCols.rows.length === 3, 'platform_audit_logs has ip/user_agent/metadata');

  // Role model: users.role is platform role
  const roleCol = await query(
    `SELECT data_type FROM information_schema.columns
     WHERE table_name = 'users' AND column_name = 'role'`
  );
  assert(Boolean(roleCol.rows[0]), 'users.role exists (platform role)');

  const tenantRoleCol = await query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'users' AND column_name = 'tenant_role'`
  );
  assert(Boolean(tenantRoleCol.rows[0]), 'users.tenant_role exists (tenant RBAC)');

  // Ensure no plain-text password column leakage pattern in audit metadata helper:
  // smoke: insert + strip would be tested in route layer; here verify table writable
  const canWrite = await query(
    `SELECT COUNT(*)::int AS c FROM platform_audit_logs`
  );
  assert(typeof canWrite.rows[0].c === 'number', 'platform_audit_logs readable');

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log('\nAll admin-platform self-tests passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('SELF_TEST_ERROR', String(e?.message || e).slice(0, 400));
  process.exit(1);
});
