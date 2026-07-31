/**
 * Live HTTP repro for POST /api/admin-platform/accounts (meta_review).
 * Uses DB super_admin + JWT. Does not log passwords/tokens.
 */
import dotenv from 'dotenv';
dotenv.config();

import jwt from 'jsonwebtoken';
import { pool } from '../config/database';

const BASE = process.env.API_BASE || 'http://localhost:5000';

async function main() {
  const sa = await pool.query(
    `SELECT id, email, role, tenant_id, COALESCE(permission_version, 1) AS permission_version
     FROM users WHERE role='super_admin' ORDER BY id LIMIT 1`
  );
  if (!sa.rows[0]) {
    console.error('No super_admin user in DB');
    process.exit(1);
  }
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.error('JWT_SECRET missing');
    process.exit(1);
  }
  const token = jwt.sign(
    {
      userId: sa.rows[0].id,
      email: sa.rows[0].email,
      role: sa.rows[0].role,
      tenantId: sa.rows[0].tenant_id,
      permissionVersion: Number(sa.rows[0].permission_version || 1),
    },
    secret,
    { expiresIn: '15m' }
  );

  const dupBody = {
    mode: 'meta_review',
    companyName: 'Meta Review',
    companyEmail: 'review@woontegra.com',
    userName: 'Meta Review',
    userEmail: 'review@woontegra.com',
    tenantRole: 'OWNER',
    planCode: 'STARTER',
    isTestAccount: true,
    isTrial: true,
    expiresAt: '2026-08-14T21:00',
    periodEnd: '2026-08-14T21:00',
    notes: 'Meta App Review inceleme hesabı',
  };

  console.log('=== DUPLICATE EMAIL CALL ===');
  const r1 = await fetch(`${BASE}/api/admin-platform/accounts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(dupBody),
  });
  const t1 = await r1.text();
  console.log('status:', r1.status);
  console.log('body:', t1.slice(0, 500));

  const stamp = Date.now();
  const freshEmail = `meta.review.live.${stamp}@woontegra.com`;
  const freshBody = {
    ...dupBody,
    companyName: `Meta Review Live ${stamp}`,
    companyEmail: freshEmail,
    userEmail: freshEmail,
    userName: 'Meta Review',
    temporaryPassword: 'McReview99A!',
  };

  console.log('\n=== FRESH META CREATE ===');
  const r2 = await fetch(`${BASE}/api/admin-platform/accounts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(freshBody),
  });
  const t2 = await r2.text();
  console.log('status:', r2.status);
  console.log('body:', t2.slice(0, 800).replace(/temporaryPassword":"[^"]+"/g, 'temporaryPassword":"[REDACTED]"'));

  if (r2.status === 201) {
    const j = JSON.parse(t2);
    const tid = j.data?.tenant?.id;
    const verify = await pool.query(
      `SELECT t.is_test_account, t.expires_at, u.email, u.role, u.tenant_role,
              (u.password ~ '^\\$2[aby]\\$') AS hashed,
              (SELECT COUNT(*)::int FROM brands b WHERE b.tenant_id=t.id) AS brands,
              (SELECT COUNT(*)::int FROM subscriptions s WHERE s.tenant_id=t.id) AS subs,
              (SELECT COUNT(*)::int FROM platform_audit_logs a WHERE a.tenant_id=t.id) AS audits
       FROM tenants t
       JOIN users u ON u.tenant_id=t.id AND LOWER(u.email)=LOWER($2)
       WHERE t.id=$1`,
      [tid, freshEmail]
    );
    console.log('verify:', verify.rows[0]);

    console.log('\n=== SECOND CALL SAME EMAIL (expect 409) ===');
    const r3 = await fetch(`${BASE}/api/admin-platform/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(freshBody),
    });
    const t3 = await r3.text();
    console.log('status:', r3.status);
    console.log('body:', t3.slice(0, 400));
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error('SCRIPT_ERROR', e?.message || e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
