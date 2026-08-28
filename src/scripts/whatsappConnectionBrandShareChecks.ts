/**
 * WhatsApp connection brand-share logic checks (no DB).
 * Run: npx ts-node src/scripts/whatsappConnectionBrandShareChecks.ts
 */
import assert from 'assert';
import { brandAccessSql } from '../services/channelConnectionBrandShareService';

assert.ok(
  brandAccessSql(3).includes('channel_connection_brand_shares'),
  'brand access sql includes share table'
);
assert.ok(brandAccessSql(3).includes('$3'), 'brand access sql uses brand param');

function canUseConnection(params: {
  ownerBrandId: number;
  sharedBrandIds: number[];
  targetBrandId: number;
}): boolean {
  if (params.ownerBrandId === params.targetBrandId) return true;
  return params.sharedBrandIds.includes(params.targetBrandId);
}

assert.strictEqual(
  canUseConnection({ ownerBrandId: 1, sharedBrandIds: [2], targetBrandId: 2 }),
  true,
  'shared brand can use connection'
);
assert.strictEqual(
  canUseConnection({ ownerBrandId: 1, sharedBrandIds: [2], targetBrandId: 3 }),
  false,
  'other tenant brand cannot use connection'
);
assert.strictEqual(
  canUseConnection({ ownerBrandId: 1, sharedBrandIds: [], targetBrandId: 1 }),
  true,
  'owner brand can use connection'
);

function quotaCount(rows: Array<{ id: number; phone_number_id: string | null }>): number {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.phone_number_id?.trim() || `conn:${row.id}`;
    seen.add(key);
  }
  return seen.size;
}

assert.strictEqual(
  quotaCount([
    { id: 1, phone_number_id: '525890038336054' },
    { id: 2, phone_number_id: '525890038336054' },
  ]),
  1,
  'same physical line counted once'
);
assert.strictEqual(
  quotaCount([
    { id: 1, phone_number_id: '111' },
    { id: 2, phone_number_id: '222' },
  ]),
  2,
  'different lines counted separately'
);

console.log('✓ whatsappConnectionBrandShareChecks passed');
