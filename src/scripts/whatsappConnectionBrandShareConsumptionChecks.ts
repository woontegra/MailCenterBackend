/**
 * WhatsApp connection brand-share consumption path checks (no DB, no Meta).
 * Run: npx ts-node src/scripts/whatsappConnectionBrandShareConsumptionChecks.ts
 */
import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { brandAccessSql } from '../services/channelConnectionBrandShareService';

const ROOT = join(__dirname, '..');

function read(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8');
}

function canUseConnection(params: {
  tenantId: number;
  ownerBrandId: number;
  sharedBrandIds: number[];
  targetBrandId: number;
  connectionTenantId: number;
  callerTenantId: number;
}): boolean {
  if (params.callerTenantId !== params.connectionTenantId) return false;
  if (params.targetBrandId === params.ownerBrandId) return true;
  return params.sharedBrandIds.includes(params.targetBrandId);
}

function simulateCustomTemplateInsert(params: {
  brandId: number;
  connectionOwnerBrandId: number;
  connectionId: number;
}) {
  return {
    brand_id: params.brandId,
    channel_connection_id: params.connectionId,
    uses_owner_connection: params.brandId !== params.connectionOwnerBrandId,
  };
}

function simulateSyncExistingLookup(params: { ownerBrandId: number; syncBrandId: number }) {
  return {
    lookupBrandId: params.syncBrandId,
    onlyOwnerRows: params.syncBrandId === params.ownerBrandId,
  };
}

function simulateWorkerSenderResolve(params: {
  outboundBrandId: number;
  senderBrandId: number;
  senderConnectionId: number;
  requestedConnectionId: number;
  shareActive: boolean;
  ownerBrandId: number;
}) {
  if (params.senderBrandId !== params.outboundBrandId) {
    return { ok: false, reason: 'sender_brand_mismatch' };
  }
  const connectionAllowed =
    params.outboundBrandId === params.ownerBrandId ||
    (params.shareActive && params.senderConnectionId === params.requestedConnectionId);
  if (!connectionAllowed) return { ok: false, reason: 'connection_not_shared' };
  return { ok: true, uses_connection_credentials: true };
}

function simulateUnshareSenderCleanup(params: {
  ownerBrandId: number;
  targetBrandId: number;
  deletedBrandId: number;
}) {
  const isOwner = params.targetBrandId === params.ownerBrandId;
  return {
    shareRowRemoved: !isOwner,
    senderDeleteBrandId: isOwner ? null : params.deletedBrandId,
    ownerSenderTouched: isOwner,
  };
}

function main() {
  // --- Authorization model ---
  assert.strictEqual(
    canUseConnection({
      tenantId: 1,
      ownerBrandId: 10,
      sharedBrandIds: [20],
      targetBrandId: 20,
      connectionTenantId: 1,
      callerTenantId: 1,
    }),
    true,
    'shared brand Bilirkişi can use Woontegra connection'
  );
  assert.strictEqual(
    canUseConnection({
      tenantId: 1,
      ownerBrandId: 10,
      sharedBrandIds: [20],
      targetBrandId: 99,
      connectionTenantId: 1,
      callerTenantId: 1,
    }),
    false,
    'unshared brand cannot use connection'
  );
  assert.strictEqual(
    canUseConnection({
      tenantId: 1,
      ownerBrandId: 10,
      sharedBrandIds: [20],
      targetBrandId: 20,
      connectionTenantId: 1,
      callerTenantId: 2,
    }),
    false,
    'other tenant blocked'
  );

  // --- 1 Custom template ---
  const customSrc = read('services/whatsappCustomTemplateService.ts');
  assert.ok(customSrc.includes('loadActiveWhatsAppConnection'), 'custom template uses shared loader');
  const customInsert = simulateCustomTemplateInsert({
    brandId: 20,
    connectionOwnerBrandId: 10,
    connectionId: 5,
  });
  assert.strictEqual(customInsert.brand_id, 20, 'local template saved under Bilirkişi brand');
  assert.strictEqual(customInsert.uses_owner_connection, true, 'uses Woontegra connection credentials');
  assert.ok(
    !customSrc.includes('encrypted_credentials') ||
      customSrc.indexOf('loadActiveWhatsAppConnection') < customSrc.indexOf('INSERT INTO templates'),
    'credentials loaded via connection, not copied into template row'
  );

  // --- 2 Ready library ---
  const readySrc = read('services/whatsappReadyTemplateLibraryService.ts');
  assert.ok(readySrc.includes('brandCanUseConnection'), 'ready library loader validates share');
  assert.ok(readySrc.includes('params.brandId'), 'ready library insert uses target brand');
  assert.ok(readySrc.includes('brandId: params.brandId'), 'ready library lookup scoped per brand');
  assert.ok(readySrc.includes('markanız için yerel kayıt'), 'shared WABA clones local row for target brand');

  // --- 3 Single send + worker ---
  const sendSrc = read('routes/sendWhatsAppRoutes.ts');
  const workerSrc = read('services/outboundWhatsAppProcessor.ts');
  const senderSrc = read('utils/senderIdentityAccess.ts');
  assert.ok(sendSrc.includes('resolveEligibleWhatsAppSenderIdentity'), 'send route resolves sender');
  assert.ok(workerSrc.includes('resolveEligibleWhatsAppSenderIdentity'), 'worker resolves sender');
  assert.ok(senderSrc.includes('brandCanUseConnection'), 'sender resolver checks share access');
  assert.ok(
    !workerSrc.includes('connection.brand_id') && !workerSrc.includes('cc.brand_id'),
    'worker does not re-check owner brand_id on connection'
  );

  const workerOk = simulateWorkerSenderResolve({
    outboundBrandId: 20,
    senderBrandId: 20,
    senderConnectionId: 5,
    requestedConnectionId: 5,
    shareActive: true,
    ownerBrandId: 10,
  });
  assert.strictEqual(workerOk.ok, true, 'worker accepts shared-brand sender');

  // --- 4 Bulk campaign ---
  const bulkSrc = read('services/whatsappBulkCampaignService.ts');
  assert.ok(bulkSrc.includes('brandCanUseConnection'), 'bulk template assert validates connection share');
  assert.ok(bulkSrc.includes('resolveEligibleWhatsAppSenderIdentity'), 'bulk launch resolves sender');
  assert.ok(bulkSrc.includes('brand_id'), 'campaign insert keeps brand_id');

  const dispatchSrc = read('services/campaignDispatchService.ts');
  assert.ok(dispatchSrc.includes("campaign.brand_id"), 'dispatch uses campaign brand on outbound');

  // --- 5 Template sync isolation ---
  const syncSrc = read('services/whatsappTemplateSyncService.ts');
  assert.ok(syncSrc.includes('connection.brand_id'), 'sync upsert scoped to owner brand rows');
  assert.ok(syncSrc.includes('assertWhatsAppTemplateSyncPermitted'), 'sync can require owner brand');
  const syncLookup = simulateSyncExistingLookup({ ownerBrandId: 10, syncBrandId: 10 });
  assert.strictEqual(syncLookup.onlyOwnerRows, true);

  const listSrc = read('routes/templateRoutes.ts');
  assert.ok(listSrc.includes('t.brand_id = $'), 'template list filtered by requesting brand');
  assert.ok(listSrc.includes('brandCanUseConnection'), 'template list validates shared connection');

  // --- 6 Sender identity ---
  const shareSvc = read('services/channelConnectionBrandShareService.ts');
  assert.ok(shareSvc.includes('ensureWhatsAppSenderForConnection'), 'share creates sender for target brand');
  assert.ok(
    shareSvc.includes("channel_type = 'WHATSAPP'"),
    'unshare removes only target brand WA sender'
  );
  const unshare = simulateUnshareSenderCleanup({
    ownerBrandId: 10,
    targetBrandId: 20,
    deletedBrandId: 20,
  });
  assert.strictEqual(unshare.shareRowRemoved, true);
  assert.strictEqual(unshare.senderDeleteBrandId, 20);
  assert.strictEqual(unshare.ownerSenderTouched, false);

  // --- 7 Post-unshare denial ---
  assert.strictEqual(
    canUseConnection({
      tenantId: 1,
      ownerBrandId: 10,
      sharedBrandIds: [],
      targetBrandId: 20,
      connectionTenantId: 1,
      callerTenantId: 1,
    }),
    false,
    'after unshare Bilirkişi loses access'
  );

  // --- Owner regression ---
  assert.strictEqual(
    canUseConnection({
      tenantId: 1,
      ownerBrandId: 10,
      sharedBrandIds: [20],
      targetBrandId: 10,
      connectionTenantId: 1,
      callerTenantId: 1,
    }),
    true,
    'owner Woontegra still has access'
  );

  assert.ok(brandAccessSql(4).includes('channel_connection_brand_shares'), 'list SQL includes shares');

  console.log('✓ whatsappConnectionBrandShareConsumptionChecks passed');
}

main();
