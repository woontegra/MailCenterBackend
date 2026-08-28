/**
 * WhatsApp template approval vs quality score checks (no DB, no Meta).
 * Run: npx ts-node src/scripts/whatsappTemplateStatusChecks.ts
 */
import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildProviderComponentsPayload,
  isQualityScorePending,
  mapMetaStatusToApproval,
  whatsappTemplateCanSend,
  whatsappTemplateDisplay,
} from '../utils/whatsappTemplateStatus';

const ROOT = join(__dirname, '..');

function read(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8');
}

function simulateMirrorUpdate(params: {
  ownerBrandId: number;
  rows: Array<{ id: number; brand_id: number; provider_approval_status: string }>;
  approval: string;
}) {
  return params.rows.map((row) => ({
    id: row.id,
    brand_id: row.brand_id,
    provider_approval_status: params.approval,
    name_unchanged: true,
    library_key_unchanged: true,
  }));
}

function main() {
  // --- Meta status mapping ---
  assert.strictEqual(mapMetaStatusToApproval('APPROVED'), 'APPROVED');
  assert.strictEqual(mapMetaStatusToApproval('PENDING'), 'PENDING');
  assert.strictEqual(mapMetaStatusToApproval('REJECTED'), 'REJECTED');
  assert.strictEqual(mapMetaStatusToApproval('PAUSED'), 'PAUSED');
  assert.strictEqual(mapMetaStatusToApproval('IN_APPEAL'), 'PENDING');

  // --- Quality pending does not block send ---
  const approvedQualityPending = whatsappTemplateDisplay({
    provider_approval_status: 'APPROVED',
    provider_template_components: buildProviderComponentsPayload({
      metaTemplateId: '936383158854272',
      category: 'UTILITY',
      status: 'APPROVED',
      components: [],
      wabaId: '420529479291363',
      rejectedReason: null,
      qualityScore: { score: 'UNKNOWN', status: 'PENDING' },
      lastSyncedAt: new Date().toISOString(),
    }),
  });
  assert.strictEqual(approvedQualityPending.canSend, true);
  assert.strictEqual(approvedQualityPending.label, 'Onaylandı · Gönderilebilir');
  assert.strictEqual(approvedQualityPending.help, 'Kalite puanı henüz oluşmadı.');
  assert.strictEqual(approvedQualityPending.qualityPending, true);
  assert.strictEqual(
    isQualityScorePending('APPROVED', { score: 'UNKNOWN', status: 'PENDING' }),
    true
  );

  // --- Real PENDING blocks send ---
  const reviewPending = whatsappTemplateDisplay({
    provider_approval_status: 'PENDING',
    provider_template_components: buildProviderComponentsPayload({
      metaTemplateId: '1',
      category: 'UTILITY',
      status: 'PENDING',
      components: [],
      wabaId: '420529479291363',
      rejectedReason: null,
      qualityScore: null,
      lastSyncedAt: new Date().toISOString(),
    }),
  });
  assert.strictEqual(reviewPending.canSend, false);
  assert.strictEqual(reviewPending.label, 'Meta onayı bekleniyor');
  assert.strictEqual(reviewPending.help, 'Onaylanana kadar gönderilemez.');
  assert.strictEqual(reviewPending.qualityPending, false);

  // --- REJECTED ---
  const rejected = whatsappTemplateDisplay({
    provider_approval_status: 'REJECTED',
    provider_rejection_reason: 'Invalid format',
    provider_template_components: {},
  });
  assert.strictEqual(rejected.canSend, false);
  assert.strictEqual(rejected.label, 'Reddedildi');
  assert.ok(rejected.help.includes('Invalid format'));

  // --- Send gate uses approval only ---
  assert.strictEqual(
    whatsappTemplateCanSend({
      provider_approval_status: 'APPROVED',
      provider_template_name: 'mc_odeme_vadesi_gecmis',
      is_active: true,
      is_draft: false,
    }),
    true
  );
  assert.strictEqual(
    whatsappTemplateCanSend({
      provider_approval_status: 'PENDING',
      provider_template_name: 'mc_odeme_vadesi_gecmis',
      is_active: true,
      is_draft: false,
    }),
    false
  );

  // --- Mirror sync updates all brand rows, not only owner ---
  const mirrored = simulateMirrorUpdate({
    ownerBrandId: 6,
    approval: 'APPROVED',
    rows: [
      { id: 28, brand_id: 6, provider_approval_status: 'APPROVED' },
      { id: 36, brand_id: 7, provider_approval_status: 'PENDING' },
    ],
  });
  assert.strictEqual(mirrored.length, 2);
  assert.ok(mirrored.every((r) => r.provider_approval_status === 'APPROVED'));
  assert.ok(mirrored.every((r) => r.name_unchanged && r.library_key_unchanged));

  // --- Sync service mirrors provider fields to all brand rows on same WABA+name ---
  const syncSql = read('services/whatsappTemplateSyncService.ts');
  const updateWhere = syncSql.split('UPDATE templates SET')[1]?.split('} else {')[0] || '';
  assert.ok(
    updateWhere.includes('provider_template_name = $11') &&
      updateWhere.includes('provider_approval_status = $4') &&
      !updateWhere.includes('AND brand_id ='),
    'sync UPDATE WHERE should match all brand rows on WABA+name, not owner brand only'
  );

  // --- Clone uses meta status from components, not stale approval column ---
  const cloneSrc = read('services/whatsappReadyTemplateLibraryService.ts');
  assert.ok(cloneSrc.includes('sourceComponents.status'));
  assert.ok(cloneSrc.includes('mapMetaStatusToApproval(metaStatus)'));
  assert.ok(!cloneSrc.includes("existingOnWaba.provider_approval_status || 'APPROVED'"));

  // --- Quality stored in provider_template_components, not approval column ---
  assert.ok(cloneSrc.includes('quality_score'));
  assert.ok(syncSql.includes('qualityScore: tpl.qualityScore'));

  console.log('whatsappTemplateStatusChecks: OK');
}

main();
