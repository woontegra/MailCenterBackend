/**
 * Transaction + duplicate mapping tests for meta account create (DB-level).
 * Mirrors POST /accounts meta_review steps. No plaintext password logged.
 */
import dotenv from 'dotenv';
dotenv.config();

import { pool } from '../config/database';
import { hashPassword } from '../utils/auth';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  console.log('OK:', msg);
}

async function createMetaOnce(email: string, companyName: string, actorId: number) {
  const client = await pool.connect();
  const plain = 'McReview99A!';
  try {
    await client.query('BEGIN');
    const expires = new Date(Date.now() + 14 * 86400000);
    const periodEnd = new Date(expires);
    const tenantIns = await client.query(
      `INSERT INTO tenants (
         name, status, is_active, is_test_account, expires_at, admin_notes,
         subscription_plan, settings
       ) VALUES ($1,'ACTIVE',true,true,$2,$3,'starter', $4::jsonb)
       RETURNING id, is_test_account, expires_at`,
      [
        companyName,
        expires,
        'Meta App Review inceleme hesabı',
        JSON.stringify({ contact_email: email }),
      ]
    );
    const tenantId = tenantIns.rows[0].id;
    const hash = await hashPassword(plain);
    assert(hash !== plain && hash.startsWith('$2'), 'password hashed');
    const userIns = await client.query(
      `INSERT INTO users (email, password, tenant_id, name, role, tenant_role, is_active, permission_version)
       VALUES ($1,$2,$3,$4,'user','OWNER',true,1)
       RETURNING id, role, tenant_role`,
      [email, hash, tenantId, 'Meta Review']
    );
    assert(userIns.rows[0].role === 'user', 'platform role user');
    assert(userIns.rows[0].tenant_role === 'OWNER', 'tenant_role OWNER');
    const brand = await client.query(
      `INSERT INTO brands (tenant_id, name, slug, is_active) VALUES ($1,$2,$3,true) RETURNING id`,
      [tenantId, 'Meta Review', `meta-review-${tenantId}`]
    );
    const plan = await client.query(
      `SELECT id FROM plans WHERE UPPER(COALESCE(code,name))='STARTER' OR LOWER(name)='starter' LIMIT 1`
    );
    assert(Boolean(plan.rows[0]), 'STARTER plan exists');
    await client.query(
      `INSERT INTO subscriptions (
         tenant_id, plan_id, status, billing_period, provider,
         current_period_start, current_period_end, trial_ends_at, cancel_at_period_end
       ) VALUES ($1,$2,'TRIAL','MONTHLY','manual',$3,$4,$4,false)`,
      [tenantId, plan.rows[0].id, new Date(), periodEnd]
    );
    await client.query(
      `INSERT INTO platform_audit_logs
         (actor_user_id, action, entity_type, entity_id, tenant_id, after_data)
       VALUES ($1,'REVIEW_ACCOUNT_CREATED','tenant',$2,$2,$3::jsonb)`,
      [actorId, tenantId, JSON.stringify({ email, mode: 'meta_review' })]
    );
    await client.query('COMMIT');
    return { tenantId, userId: userIns.rows[0].id, brandId: brand.rows[0].id, plain };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

async function main() {
  const sa = await pool.query(`SELECT id FROM users WHERE role='super_admin' ORDER BY id LIMIT 1`);
  const actorId = sa.rows[0]?.id || null;

  // Rollback test: fail after tenant insert
  {
    const client = await pool.connect();
    const marker = `ROLLBACK_TEST_${Date.now()}`;
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO tenants (name, status, is_active, is_test_account) VALUES ($1,'ACTIVE',true,true)`,
        [marker]
      );
      throw new Error('forced_fail');
    } catch {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const left = await pool.query(`SELECT id FROM tenants WHERE name=$1`, [marker]);
    assert(left.rows.length === 0, 'rollback removes tenant');
  }

  // Existing review@ must conflict if inserted again
  try {
    await pool.query(
      `INSERT INTO users (email, password, tenant_id, name, role, tenant_role, is_active, permission_version)
       VALUES ('review@woontegra.com','x',35,'x','user','OWNER',true,1)`
    );
    throw new Error('expected unique violation');
  } catch (e: any) {
    assert(e.code === '23505', `duplicate email PG code 23505 (got ${e.code})`);
    console.log('constraint:', e.constraint);
  }

  const stamp = Date.now();
  const email = `meta.review.tx.${stamp}@woontegra.com`;
  const created = await createMetaOnce(email, `Meta Review TX ${stamp}`, actorId);
  const verify = await pool.query(
    `SELECT t.is_test_account, t.expires_at IS NOT NULL AS has_exp,
            u.role, u.tenant_role, (u.password ~ '^\\$2[aby]\\$') AS hashed,
            (SELECT COUNT(*)::int FROM brands b WHERE b.tenant_id=t.id) AS brands,
            (SELECT COUNT(*)::int FROM subscriptions s WHERE s.tenant_id=t.id) AS subs,
            (SELECT COUNT(*)::int FROM platform_audit_logs a WHERE a.tenant_id=t.id) AS audits
     FROM tenants t JOIN users u ON u.id=$2 WHERE t.id=$1`,
    [created.tenantId, created.userId]
  );
  const v = verify.rows[0];
  assert(v.is_test_account === true, 'is_test_account');
  assert(v.has_exp === true, 'expires_at set');
  assert(v.role === 'user', 'not super_admin');
  assert(v.tenant_role === 'OWNER', 'OWNER');
  assert(v.hashed === true, 'bcrypt in DB');
  assert(v.brands >= 1, 'brand');
  assert(v.subs >= 1, 'subscription');
  assert(v.audits >= 1, 'audit');

  // Cleanup created test tenant
  await pool.query(`DELETE FROM platform_audit_logs WHERE tenant_id=$1`, [created.tenantId]);
  await pool.query(`DELETE FROM subscriptions WHERE tenant_id=$1`, [created.tenantId]);
  await pool.query(`DELETE FROM tags WHERE tenant_id=$1`, [created.tenantId]);
  await pool.query(`DELETE FROM brands WHERE tenant_id=$1`, [created.tenantId]);
  await pool.query(`DELETE FROM users WHERE tenant_id=$1`, [created.tenantId]);
  await pool.query(`DELETE FROM tenants WHERE id=$1`, [created.tenantId]);
  console.log('CLEANUP ok', created.tenantId);

  // Existing complete account report
  const existing = await pool.query(
    `SELECT u.id, t.id AS tenant_id, t.name, t.is_test_account
     FROM users u JOIN tenants t ON t.id=u.tenant_id
     WHERE LOWER(u.email)='review@woontegra.com'`
  );
  console.log('existing review@woontegra.com:', existing.rows[0] || null);

  console.log('\nDB transaction tests PASS');
  await pool.end();
}

main().catch(async (e) => {
  console.error('FAIL', e?.message || e, e?.code);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
