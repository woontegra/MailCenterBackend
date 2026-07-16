/**
 * DB-level tenant isolation + uniqueness checks (rolls back).
 * Run: npx ts-node src/scripts/contactTenantIsolationChecks.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import { pool } from '../config/database';
import { normalizeEmail, normalizePhone } from '../utils/contactNormalize';

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const t1 = await client.query(
      `INSERT INTO tenants (name) VALUES ('Contact Check A') RETURNING id`
    );
    const t2 = await client.query(
      `INSERT INTO tenants (name) VALUES ('Contact Check B') RETURNING id`
    );
    const tenantA = t1.rows[0].id;
    const tenantB = t2.rows[0].id;

    const email = normalizeEmail('Same.Person@Example.com');
    if (email.ok === false) throw new Error(email.error);

    const c1 = await client.query(
      `INSERT INTO contacts (tenant_id, first_name, status) VALUES ($1, 'Ali', 'ACTIVE') RETURNING id`,
      [tenantA]
    );
    const c2 = await client.query(
      `INSERT INTO contacts (tenant_id, first_name, status) VALUES ($1, 'Ali', 'ACTIVE') RETURNING id`,
      [tenantB]
    );

    await client.query(
      `INSERT INTO contact_points (tenant_id, contact_id, channel_type, value, normalized_value, is_primary)
       VALUES ($1, $2, 'EMAIL', $3, $4, true)`,
      [tenantA, c1.rows[0].id, email.value, email.normalized]
    );
    await client.query(
      `INSERT INTO contact_points (tenant_id, contact_id, channel_type, value, normalized_value, is_primary)
       VALUES ($1, $2, 'EMAIL', $3, $4, true)`,
      [tenantB, c2.rows[0].id, email.value, email.normalized]
    );

    let dupFailed = false;
    await client.query('SAVEPOINT dup_test');
    try {
      await client.query(
        `INSERT INTO contact_points (tenant_id, contact_id, channel_type, value, normalized_value, is_primary)
         VALUES ($1, $2, 'EMAIL', $3, $4, false)`,
        [tenantA, c1.rows[0].id, 'other@example.com', email.normalized]
      );
    } catch (e: any) {
      if (e.code === '23505') {
        dupFailed = true;
        await client.query('ROLLBACK TO SAVEPOINT dup_test');
      } else {
        throw e;
      }
    }
    if (!dupFailed) throw new Error('Expected duplicate normalized email in same tenant');
    await client.query('RELEASE SAVEPOINT dup_test');

    const cross = await client.query(
      `SELECT id FROM contacts WHERE id = $1 AND tenant_id = $2`,
      [c1.rows[0].id, tenantB]
    );
    if (cross.rows.length !== 0) throw new Error('Cross-tenant contact visible');

    await client.query(
      `INSERT INTO communication_preferences (tenant_id, contact_id, channel_type, status, source)
       VALUES ($1, $2, 'EMAIL', 'OPTED_OUT', 'user_explicit')`,
      [tenantA, c1.rows[0].id]
    );
    await client.query(
      `INSERT INTO consent_events (tenant_id, contact_id, channel_type, previous_status, new_status, source)
       VALUES ($1, $2, 'EMAIL', 'UNKNOWN', 'OPTED_OUT', 'user_explicit')`,
      [tenantA, c1.rows[0].id]
    );
    await client.query(
      `UPDATE communication_preferences SET status = 'BLOCKED', source = 'user_explicit'
       WHERE tenant_id = $1 AND contact_id = $2 AND channel_type = 'EMAIL'`,
      [tenantA, c1.rows[0].id]
    );
    await client.query(
      `INSERT INTO consent_events (tenant_id, contact_id, channel_type, previous_status, new_status, source)
       VALUES ($1, $2, 'EMAIL', 'OPTED_OUT', 'BLOCKED', 'user_explicit')`,
      [tenantA, c1.rows[0].id]
    );

    const history = await client.query(
      `SELECT previous_status, new_status FROM consent_events
       WHERE tenant_id = $1 AND contact_id = $2 ORDER BY id`,
      [tenantA, c1.rows[0].id]
    );
    if (history.rows.length < 2) throw new Error('Consent history missing');

    await client.query(
      `UPDATE contacts SET status = 'ARCHIVED' WHERE id = $1 AND tenant_id = $2`,
      [c1.rows[0].id, tenantA]
    );
    const stillPoints = await client.query(
      `SELECT id FROM contact_points WHERE contact_id = $1`,
      [c1.rows[0].id]
    );
    if (stillPoints.rows.length === 0) throw new Error('Archive deleted points');

    const phone = normalizePhone({ value: '5321112233', countryCode: '90' });
    if (phone.ok === false) throw new Error(phone.error);
    if (phone.normalized !== '+905321112233') throw new Error('phone normalize mismatch');

    console.log('✓ contactTenantIsolationChecks passed (rolled back)');
    await client.query('ROLLBACK');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
