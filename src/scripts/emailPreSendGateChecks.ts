/**
 * Pre-send email gate checks (policy + DB scenarios with cleanup).
 * Run: npx ts-node src/scripts/emailPreSendGateChecks.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import assert from 'assert';
import { query, pool } from '../config/database';
import {
  evaluateEmailPreSendGate,
  resolveEmailSendPolicy,
  userMessageForSuppression,
} from '../services/emailPreSendGateService';
import { upsertSuppression } from '../services/suppressionService';

function section(title: string) {
  console.log(`\n— ${title}`);
}

section('policy + message mapping');
assert.strictEqual(
  resolveEmailSendPolicy({ idempotencyKey: 'team_invite_1_a@b.com_123' }),
  'transactional'
);
assert.strictEqual(
  resolveEmailSendPolicy({ campaignId: 10, campaignRecipientId: 20 }),
  'marketing'
);
assert.strictEqual(resolveEmailSendPolicy({ conversationId: 5 }), 'standard');
assert.strictEqual(userMessageForSuppression('UNSUBSCRIBED'), 'Abonelikten çıktı');
assert.strictEqual(
  userMessageForSuppression('BOUNCE_PERMANENT'),
  'Kalıcı teslim hatası nedeniyle engellendi'
);
assert.strictEqual(userMessageForSuppression('SPAM_COMPLAINT'), 'Şikâyet nedeniyle engellendi');
console.log('✓ policy + messages');

async function seedCampaignFixture() {
  const tenant = await query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [
    `PreSend Gate ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  ]);
  const tenantId = tenant.rows[0].id;

  const campaign = await query(
    `INSERT INTO campaigns (
       tenant_id, name, subject, status, recipient_count, created_by
     ) VALUES ($1, 'Gate Test', 'Konu', 'SENDING', 1, NULL)
     RETURNING id`,
    [tenantId]
  );
  const campaignId = campaign.rows[0].id;

  const recipient = await query(
    `INSERT INTO campaign_recipients (
       campaign_id, tenant_id, email, email_normalized, status
     ) VALUES ($1, $2, 'gate.test@example.com', 'gate.test@example.com', 'QUEUED')
     RETURNING id`,
    [campaignId, tenantId]
  );

  const contact = await query(
    `INSERT INTO contacts (tenant_id, first_name, status)
     VALUES ($1, 'Gate', 'ACTIVE') RETURNING id`,
    [tenantId]
  );
  const contactId = contact.rows[0].id;

  await query(
    `INSERT INTO contact_points (
       tenant_id, contact_id, channel_type, value, normalized_value, is_primary, is_active
     ) VALUES ($1, $2, 'EMAIL', 'gate.test@example.com', 'gate.test@example.com', true, true)`,
    [tenantId, contactId]
  );

  await query(
    `INSERT INTO communication_preferences (
       tenant_id, contact_id, channel_type, brand_id, status
     ) VALUES ($1, $2, 'EMAIL', NULL, 'OPTED_IN')`,
    [tenantId, contactId]
  );

  return {
    tenantId,
    campaignId,
    campaignRecipientId: recipient.rows[0].id,
    contactId,
    email: 'gate.test@example.com',
  };
}

async function cleanupTenant(tenantId: number) {
  await query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
}

async function runDbScenarios() {
  section('1. unsubscribe after snapshot blocks send');
  {
    const fx = await seedCampaignFixture();
    try {
      await upsertSuppression({
        tenantId: fx.tenantId,
        email: fx.email,
        reason: 'UNSUBSCRIBED',
        source: 'test',
      });

      const gate = await evaluateEmailPreSendGate({
        tenantId: fx.tenantId,
        campaignId: fx.campaignId,
        campaignRecipientId: fx.campaignRecipientId,
        toAddresses: [fx.email],
      });

      assert.strictEqual(gate.allowed, false);
      if (gate.allowed) throw new Error('expected block');
      assert.strictEqual(gate.code, 'UNSUBSCRIBED');
      assert.strictEqual(gate.userMessage, 'Abonelikten çıktı');
      console.log('✓ unsubscribe blocks');
    } finally {
      await cleanupTenant(fx.tenantId);
    }
  }

  section('2. hard bounce suppression blocks send');
  {
    const fx = await seedCampaignFixture();
    try {
      await upsertSuppression({
        tenantId: fx.tenantId,
        email: fx.email,
        reason: 'BOUNCE_PERMANENT',
        source: 'test',
      });

      const gate = await evaluateEmailPreSendGate({
        tenantId: fx.tenantId,
        campaignId: fx.campaignId,
        campaignRecipientId: fx.campaignRecipientId,
        toAddresses: [fx.email],
      });

      assert.strictEqual(gate.allowed, false);
      if (gate.allowed) throw new Error('expected block');
      assert.strictEqual(gate.code, 'BOUNCE_PERMANENT');
      console.log('✓ bounce suppression blocks');
    } finally {
      await cleanupTenant(fx.tenantId);
    }
  }

  section('3. permission removed after snapshot blocks send');
  {
    const fx = await seedCampaignFixture();
    try {
      await query(
        `UPDATE communication_preferences
         SET status = 'OPTED_OUT'
         WHERE tenant_id = $1 AND contact_id = $2 AND channel_type = 'EMAIL'`,
        [fx.tenantId, fx.contactId]
      );

      const gate = await evaluateEmailPreSendGate({
        tenantId: fx.tenantId,
        campaignId: fx.campaignId,
        campaignRecipientId: fx.campaignRecipientId,
        toAddresses: [fx.email],
      });

      assert.strictEqual(gate.allowed, false);
      if (gate.allowed) throw new Error('expected block');
      assert.strictEqual(gate.code, 'NO_PERMISSION');
      assert.strictEqual(gate.userMessage, 'İletişim izni bulunmuyor');
      console.log('✓ permission removal blocks');
    } finally {
      await cleanupTenant(fx.tenantId);
    }
  }

  section('4. paused / cancelled campaign blocks send');
  {
    const fx = await seedCampaignFixture();
    try {
      await query(`UPDATE campaigns SET status = 'PAUSED' WHERE id = $1`, [fx.campaignId]);

      const paused = await evaluateEmailPreSendGate({
        tenantId: fx.tenantId,
        campaignId: fx.campaignId,
        campaignRecipientId: fx.campaignRecipientId,
        toAddresses: [fx.email],
      });
      assert.strictEqual(paused.allowed, false);
      if (paused.allowed) throw new Error('expected pause block');
      assert.strictEqual(paused.code, 'CAMPAIGN_STOPPED');
      assert.strictEqual(paused.userMessage, 'Kampanya durduruldu');

      await query(`UPDATE campaigns SET status = 'CANCELLED' WHERE id = $1`, [fx.campaignId]);
      const cancelled = await evaluateEmailPreSendGate({
        tenantId: fx.tenantId,
        campaignId: fx.campaignId,
        campaignRecipientId: fx.campaignRecipientId,
        toAddresses: [fx.email],
      });
      assert.strictEqual(cancelled.allowed, false);
      if (cancelled.allowed) throw new Error('expected cancel block');
      console.log('✓ paused/cancelled campaign blocks');
    } finally {
      await cleanupTenant(fx.tenantId);
    }
  }

  section('5. already-sent recipient blocks duplicate send');
  {
    const fx = await seedCampaignFixture();
    try {
      await query(
        `UPDATE campaign_recipients SET status = 'SENT', sent_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [fx.campaignRecipientId]
      );

      const gate = await evaluateEmailPreSendGate({
        tenantId: fx.tenantId,
        campaignId: fx.campaignId,
        campaignRecipientId: fx.campaignRecipientId,
        toAddresses: [fx.email],
      });

      assert.strictEqual(gate.allowed, false);
      if (gate.allowed) throw new Error('expected duplicate block');
      assert.strictEqual(gate.code, 'RECIPIENT_ALREADY_HANDLED');
      console.log('✓ duplicate recipient blocked');
    } finally {
      await cleanupTenant(fx.tenantId);
    }
  }

  section('6. eligible recipient passes gate');
  {
    const fx = await seedCampaignFixture();
    try {
      const gate = await evaluateEmailPreSendGate({
        tenantId: fx.tenantId,
        campaignId: fx.campaignId,
        campaignRecipientId: fx.campaignRecipientId,
        toAddresses: [fx.email],
      });
      assert.strictEqual(gate.allowed, true);
      console.log('✓ eligible recipient allowed');
    } finally {
      await cleanupTenant(fx.tenantId);
    }
  }

  section('7. transactional invite ignores marketing suppression');
  {
    const tenant = await query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [
      `Invite Test ${Date.now()}`,
    ]);
    const tenantId = tenant.rows[0].id;
    const email = 'invited@example.com';
    try {
      await upsertSuppression({
        tenantId,
        email,
        reason: 'UNSUBSCRIBED',
        source: 'test',
      });

      const gate = await evaluateEmailPreSendGate({
        tenantId,
        idempotencyKey: `team_invite_${tenantId}_${email}_123`,
        toAddresses: [email],
      });

      assert.strictEqual(gate.allowed, true);
      console.log('✓ transactional invite bypasses marketing suppression');
    } finally {
      await cleanupTenant(tenantId);
    }
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('⚠ DATABASE_URL missing — DB scenarios skipped');
    console.log('\nAll emailPreSendGateChecks passed (policy-only).');
    return;
  }

  await runDbScenarios();
  console.log('\nAll emailPreSendGateChecks passed.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
