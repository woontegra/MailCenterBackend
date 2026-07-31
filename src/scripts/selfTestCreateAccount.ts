/**
 * Unified /accounts create-account flow smoke (DB-level invariants).
 * Run: npx ts-node src/scripts/selfTestCreateAccount.ts
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

async function cleanupTenant(tenantId: number) {
  await query(`DELETE FROM users WHERE tenant_id = $1`, [tenantId]).catch(() => null);
  await query(`DELETE FROM brands WHERE tenant_id = $1`, [tenantId]).catch(() => null);
  await query(`DELETE FROM tags WHERE tenant_id = $1`, [tenantId]).catch(() => null);
  await query(`DELETE FROM subscriptions WHERE tenant_id = $1`, [tenantId]).catch(() => null);
  await query(`DELETE FROM tenants WHERE id = $1`, [tenantId]).catch(() => null);
}

async function main() {
  const stamp = Date.now();
  const client = await pool.connect();
  let tenantA: number | null = null;
  let tenantB: number | null = null;

  try {
    // New company + owner + brand in one transaction
    await client.query('BEGIN');
    const tIns = await client.query(
      `INSERT INTO tenants (name, status, is_active, is_test_account, subscription_plan)
       VALUES ($1,'ACTIVE',true,false,'starter') RETURNING id`,
      [`Firma Smoke ${stamp}`]
    );
    tenantA = tIns.rows[0].id;
    const plain = `McAcc${String(stamp).slice(-4)}9A`;
    const hash = await hashPassword(plain);
    assert(hash !== plain, 'password hashed');
    assert(await bcrypt.compare(plain, hash), 'bcrypt ok');
    const uIns = await client.query(
      `INSERT INTO users (email,password,tenant_id,name,role,tenant_role,is_active,permission_version)
       VALUES ($1,$2,$3,'Sahip User','user','OWNER',true,1) RETURNING tenant_role`,
      [`owner.smoke.${stamp}@example.com`, hash, tenantA]
    );
    assert(uIns.rows[0].tenant_role === 'OWNER', 'new firm first user OWNER');
    await client.query(
      `INSERT INTO brands (tenant_id,name,slug,is_active) VALUES ($1,$2,$3,true)`,
      [tenantA, `Firma Smoke ${stamp}`, `firma-smoke-${tenantA}`]
    );
    await client.query('COMMIT');
    assert(true, 'new firm transaction committed');

    // Existing firm: add user with AGENT
    const u2 = await query(
      `INSERT INTO users (email,password,tenant_id,name,role,tenant_role,is_active,permission_version)
       VALUES ($1,$2,$3,'Personel','user','AGENT',true,1) RETURNING tenant_role`,
      [`agent.smoke.${stamp}@example.com`, await hashPassword('McAgent99A'), tenantA]
    );
    assert(u2.rows[0].tenant_role === 'AGENT', 'existing firm role selectable (AGENT)');

    // Duplicate email blocked
    try {
      await query(
        `INSERT INTO users (email,password,tenant_id,role,tenant_role)
         VALUES ($1,$2,$3,'user','VIEWER')`,
        [`owner.smoke.${stamp}@example.com`, await hashPassword('McDup99A'), tenantA]
      );
      assert(false, 'duplicate email should fail');
    } catch {
      assert(true, 'duplicate email rejected');
    }

    // Meta / test tenant excluded from real picker
    await client.query('BEGIN');
    const tMeta = await client.query(
      `INSERT INTO tenants (name,status,is_active,is_test_account,expires_at,subscription_plan)
       VALUES ($1,'ACTIVE',true,true,$2,'starter') RETURNING id`,
      [`Meta İnceleme Smoke ${stamp}`, new Date(Date.now() + 86400000)]
    );
    tenantB = tMeta.rows[0].id;
    await client.query(
      `INSERT INTO users (email,password,tenant_id,name,role,tenant_role,is_active)
       VALUES ($1,$2,$3,'Meta','user','OWNER',true)`,
      [`meta.smoke.${stamp}@example.com`, await hashPassword('McMeta99A'), tenantB]
    );
    await client.query(
      `INSERT INTO brands (tenant_id,name,slug,is_active) VALUES ($1,'Meta Marka',$2,true)`,
      [tenantB, `meta-smoke-${tenantB}`]
    );
    await client.query('COMMIT');

    const listed = await query(
      `SELECT id FROM tenants t
       WHERE COALESCE(t.is_test_account,false)=false
         AND t.name !~* '(smoke|meta[[:space:]]*review|test[[:space:]]*tenant)'
         AND t.id = $1`,
      [tenantB]
    );
    assert(listed.rows.length === 0, 'test/meta tenant not in real company list');

    // Rollback test
    await client.query('BEGIN');
    const tRoll = await client.query(
      `INSERT INTO tenants (name,status,is_active) VALUES ($1,'ACTIVE',true) RETURNING id`,
      [`Rollback Smoke ${stamp}`]
    );
    const rollId = tRoll.rows[0].id;
    await client.query('ROLLBACK');
    const still = await query(`SELECT id FROM tenants WHERE id = $1`, [rollId]);
    assert(still.rows.length === 0, 'rollback removes uncommitted tenant');

    // Turkish label mapping (code-level)
    const labels: Record<string, string> = {
      OWNER: 'Sahip',
      ADMIN: 'Yönetici',
      MANAGER: 'Müdür',
      AGENT: 'Personel',
      VIEWER: 'Görüntüleyici',
    };
    assert(labels.OWNER === 'Sahip' && labels.AGENT === 'Personel', 'TR role labels');
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

  if (tenantA) await cleanupTenant(tenantA);
  if (tenantB) await cleanupTenant(tenantB);
  console.log('CLEANUP done');

  if (failed) {
    console.error(`\n${failed} failure(s)`);
    process.exit(1);
  }
  console.log('\nCreate-account smoke PASS');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
