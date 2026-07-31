/**
 * Elevate an existing user to platform SUPER_ADMIN (users.role = super_admin).
 *
 * Usage:
 *   SUPER_ADMIN_EMAIL=info@woontegra.com npx ts-node src/scripts/elevateSuperAdmin.ts
 *
 * Does not create users. Does not print passwords.
 */
import dotenv from 'dotenv';
dotenv.config();

import { query } from '../config/database';

async function main() {
  const email = String(process.env.SUPER_ADMIN_EMAIL || '')
    .trim()
    .toLowerCase();
  if (!email || !email.includes('@')) {
    console.error('SUPER_ADMIN_EMAIL env is required (e.g. info@woontegra.com)');
    process.exit(1);
  }

  const found = await query(
    `SELECT id, email, role, tenant_id, COALESCE(is_active,true) AS is_active
     FROM users WHERE LOWER(email) = $1`,
    [email]
  );
  if (!found.rows[0]) {
    console.error(`USER_NOT_FOUND: no user with email ${email}`);
    process.exit(1);
  }

  const user = found.rows[0];
  if (user.role === 'super_admin') {
    console.log('ALREADY_SUPER_ADMIN', { id: user.id, email: user.email });
    process.exit(0);
  }

  await query(
    `UPDATE users
     SET role = 'super_admin',
         permission_version = COALESCE(permission_version, 1) + 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [user.id]
  );

  console.log('ELEVATED_TO_SUPER_ADMIN', {
    id: user.id,
    email: user.email,
    tenantId: user.tenant_id,
    previousRole: user.role,
  });
  console.log('Re-login required so JWT picks up the new role.');
  process.exit(0);
}

main().catch((e) => {
  console.error('ELEVATE_FAILED', String(e?.message || e).slice(0, 300));
  process.exit(1);
});
