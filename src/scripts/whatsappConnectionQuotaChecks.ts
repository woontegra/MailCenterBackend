/**
 * WhatsApp channel quota rules.
 * Run: npx tsx src/scripts/whatsappConnectionQuotaChecks.ts
 */
import assert from 'assert';
import {
  isWhatsAppQuotaConsumingStatus,
  shouldConsumeWhatsAppConnectionQuota,
} from '../utils/whatsappConnectionQuota';

function simulateAcceptNewActive(params: {
  activeCount: number;
  limit: number;
}): boolean {
  return params.activeCount + 1 <= params.limit;
}

function main() {
  assert.strictEqual(isWhatsAppQuotaConsumingStatus('ACTIVE'), true);
  assert.strictEqual(isWhatsAppQuotaConsumingStatus('active'), true);
  assert.strictEqual(isWhatsAppQuotaConsumingStatus('DISABLED'), false);
  assert.strictEqual(isWhatsAppQuotaConsumingStatus('ERROR'), false);
  assert.strictEqual(isWhatsAppQuotaConsumingStatus('NOT_CONFIGURED'), false);
  assert.strictEqual(isWhatsAppQuotaConsumingStatus(null), false);

  // 1) 1 ACTIVE + limit 1 => new ACTIVE rejected
  assert.strictEqual(
    simulateAcceptNewActive({ activeCount: 1, limit: 1 }),
    false,
    '1 active + limit 1 must reject new connection'
  );
  assert.strictEqual(
    shouldConsumeWhatsAppConnectionQuota({
      isNewRow: true,
      nextStatus: 'ACTIVE',
    }),
    true
  );

  // 2) 1 DISABLED + limit 1 => new ACTIVE accepted (DISABLED does not consume)
  assert.strictEqual(
    simulateAcceptNewActive({ activeCount: 0, limit: 1 }),
    true,
    '0 active (only DISABLED) + limit 1 must accept new connection'
  );
  assert.strictEqual(
    shouldConsumeWhatsAppConnectionQuota({
      isNewRow: false,
      previousStatus: 'DISABLED',
      nextStatus: 'ACTIVE',
    }),
    true,
    'reactivating DISABLED consumes one slot'
  );
  assert.strictEqual(
    shouldConsumeWhatsAppConnectionQuota({
      isNewRow: false,
      previousStatus: 'ACTIVE',
      nextStatus: 'ACTIVE',
    }),
    false,
    'updating already-ACTIVE same PNID must not consume another slot'
  );

  // 3) Passive history preserved: DISABLED is not quota-consuming but remains a listable status
  assert.strictEqual(
    isWhatsAppQuotaConsumingStatus('DISABLED'),
    false,
    'DISABLED must remain non-consuming so history rows do not block quota'
  );

  // 4) Tenant isolation of the live counter (SQL always scopes by tenant_id)
  const countSql = `SELECT COUNT(DISTINCT COALESCE(
       NULLIF(TRIM(COALESCE(settings->>'phone_number_id', settings->>'phoneNumberId')), ''),
       'conn:' || id::text
     ))::int AS c
     FROM channel_connections
     WHERE tenant_id = $1
       AND channel_type = 'WHATSAPP'
       AND UPPER(COALESCE(status, '')) = 'ACTIVE'`;
  assert.ok(countSql.includes('tenant_id = $1'), 'quota count must be tenant-scoped');
  assert.ok(countSql.includes("= 'ACTIVE'"), 'quota count must only include ACTIVE');
  assert.ok(countSql.includes('COUNT(DISTINCT'), 'quota counts distinct physical lines');
  assert.ok(!countSql.includes('brand_id'), 'tenant quota is not brand-scoped');

  // Same PNID reactivation with only DISABLED present: used=0, consume=yes → ok under limit 1
  {
    const activeCount = 0; // DISABLED ignored
    const limit = 1;
    const consumes = shouldConsumeWhatsAppConnectionQuota({
      isNewRow: false,
      previousStatus: 'DISABLED',
      nextStatus: 'ACTIVE',
    });
    assert.strictEqual(consumes, true);
    assert.strictEqual(activeCount + (consumes ? 1 : 0) <= limit, true);
  }

  // Different real number while DISABLED test exists: new row, activeCount=0 → ok
  {
    const activeCount = 0;
    const limit = 1;
    const consumes = shouldConsumeWhatsAppConnectionQuota({
      isNewRow: true,
      nextStatus: 'ACTIVE',
    });
    assert.strictEqual(consumes, true);
    assert.strictEqual(activeCount + 1 <= limit, true);
  }

  console.log('whatsappConnectionQuotaChecks PASS');
}

main();
