/**
 * End-to-end local smoke for Meta review account creation path.
 * Run: npx ts-node src/scripts/selfTestMetaReviewAccount.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import bcrypt from 'bcrypt';
import { pool, query } from '../config/database';
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

function slugify(name: string, id: number) {
  const base =
    String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'firma';
  return `${base}-${id}`;
}

async function main() {
  const stamp = Date.now();
  const email = `meta.review.smoke.${stamp}@example.com`;
  const plain = `McReview${String(stamp).slice(-4)}9A`;
  const companyName = `Meta İnceleme Smoke ${stamp}`;
  const client = await pool.connect();
  let tenantId: number | null = null;

  try {
    await client.query('BEGIN');
    const tenantIns = await client.query(
      `INSERT INTO tenants (name, status, is_active, is_test_account, expires_at, admin_notes, subscription_plan)
       VALUES ($1, 'ACTIVE', true, true, $2, $3, 'starter')
       RETURNING id, is_test_account, expires_at`,
      [companyName, new Date(Date.now() + 7 * 86400000), 'smoke test']
    );
    tenantId = tenantIns.rows[0].id;
    assert(tenantIns.rows[0].is_test_account === true, 'is_test_account=true');

    const passwordHash = await hashPassword(plain);
    assert(passwordHash !== plain, 'password hashed');
    assert(await bcrypt.compare(plain, passwordHash), 'bcrypt verifies');

    const userIns = await client.query(
      `INSERT INTO users (email, password, tenant_id, name, role, tenant_role, is_active, permission_version)
       VALUES ($1,$2,$3,$4,'user','OWNER',true,1)
       RETURNING id, tenant_role, role`,
      [email, passwordHash, tenantId, 'Meta İnceleme']
    );
    assert(userIns.rows[0].tenant_role === 'OWNER', 'owner tenant_role OWNER');
    assert(userIns.rows[0].role !== 'super_admin', 'platform role is normal user');

    const brandIns = await client.query(
      `INSERT INTO brands (tenant_id, name, slug, is_active)
       VALUES ($1, 'Meta İnceleme Markası', $2, true)
       RETURNING id`,
      [tenantId, slugify(companyName, tenantId!)]
    );
    assert(Boolean(brandIns.rows[0].id), 'default brand created');

    await client.query('COMMIT');

    const listed = await query(
      `SELECT id FROM tenants t
       WHERE COALESCE(t.is_test_account,false) = false
         AND t.name !~* '(smoke|meta[[:space:]]*review|test[[:space:]]*tenant)'
         AND t.id = $1`,
      [tenantId]
    );
    assert(listed.rows.length === 0, 'review tenant excluded from real-company picker');

    const found = await query(
      `SELECT t.is_test_account, u.email, b.id AS brand_id
       FROM tenants t
       JOIN users u ON u.tenant_id = t.id
       JOIN brands b ON b.tenant_id = t.id
       WHERE t.id = $1`,
      [tenantId]
    );
    assert(found.rows.length >= 1, 'tenant+user+brand readable together');
    assert(found.rows[0].email === email, 'owner email matches');
  } catch (e: any) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    console.error('SMOKE_ERROR', String(e?.message || e).slice(0, 400));
    failed += 1;
  } finally {
    client.release();
  }

  // Cleanup smoke rows
  if (tenantId) {
    await query(`DELETE FROM users WHERE tenant_id = $1`, [tenantId]).catch(() => null);
    await query(`DELETE FROM brands WHERE tenant_id = $1`, [tenantId]).catch(() => null);
    await query(`DELETE FROM tags WHERE tenant_id = $1`, [tenantId]).catch(() => null);
    await query(`DELETE FROM subscriptions WHERE tenant_id = $1`, [tenantId]).catch(() => null);
    await query(`DELETE FROM tenants WHERE id = $1`, [tenantId]).catch(() => null);
    console.log('CLEANUP: smoke tenant removed', tenantId);
  }

  if (failed) {
    console.error(`\n${failed} failure(s)`);
    process.exit(1);
  }
  console.log('\nMeta review account smoke PASS');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
