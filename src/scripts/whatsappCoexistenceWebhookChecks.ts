/**
 * Coexistence webhook + processor + sync guard checks. No database, no Meta network.
 * Run: DATABASE_URL=postgresql://blocked:blocked@127.0.0.1:1/blocked npx ts-node src/scripts/whatsappCoexistenceWebhookChecks.ts
 */
import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import express from 'express';
import {
  classifyCoexistenceLookup,
  collectWebhookRoutingIds,
  computeChangeDedupeKey,
  describeDisconnectReason,
  extractCoexistenceChanges,
  mapHistoryStatusToOutbound,
  parseAccountUpdate,
  parseHistoryValue,
  parseMessageEchoes,
  parseStateSync,
  splitContactName,
} from '../whatsapp/coexistenceWebhook';
import {
  CoexistenceLiveCheck,
  CoexistenceProcessorDeps,
  CoexistenceVerificationPendingError,
  drainCoexistenceEvents,
  processAccountUpdate,
  processHistory,
  processMessageEchoes,
  processStateSync,
  storeCoexistenceChanges,
} from '../services/whatsappCoexistenceProcessor';
import {
  createWhatsAppWebhookBodyParser,
  createWhatsAppWebhookRateLimiter,
  isWhatsAppWebhookPath,
} from '../middleware/whatsappWebhookMiddleware';
import { createWhatsAppWebhookRouter, WhatsAppWebhookRouteDeps } from '../routes/whatsappWebhookRoutes';
import {
  CoexistenceSyncError,
  evaluateCoexistenceSyncEligibility,
  requestCoexistenceSync,
  getCoexistenceStatus,
} from '../services/whatsappCoexistenceSyncService';
import { requestSmbAppDataSync } from '../services/metaEmbeddedSignupService';
import { coexistenceVerificationWarnings, mergeReconnectSettings } from '../whatsapp/coexistenceSettings';

const WABA = '420529479291363';
const PNID = '525890038336054';
const BIZ = '905323171755';
const USER = '905551112233';

// --- Meta doc-shaped payloads -------------------------------------------------

const historyPayload = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: WABA,
      changes: [
        {
          field: 'history',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: BIZ, phone_number_id: PNID },
            history: [
              {
                metadata: { phase: 0, chunk_order: 1, progress: 55 },
                threads: [
                  {
                    id: USER,
                    messages: [
                      {
                        from: BIZ,
                        id: 'wamid.OUT1',
                        timestamp: '1739230955',
                        type: 'text',
                        text: { body: 'Merhaba, nasıl yardımcı olabilirim?' },
                        history_context: { status: 'READ' },
                      },
                      {
                        from: BIZ,
                        id: 'wamid.PH1',
                        timestamp: '1739230970',
                        type: 'media_placeholder',
                        history_context: { status: 'PLAYED' },
                      },
                      {
                        from: USER,
                        id: 'wamid.IN1',
                        timestamp: '1739230980',
                        type: 'text',
                        text: { body: 'Teşekkürler' },
                        history_context: { status: 'READ' },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
    },
  ],
};

const historyDeclinedValue = {
  messaging_product: 'whatsapp',
  metadata: { display_phone_number: BIZ, phone_number_id: PNID },
  history: [
    {
      errors: [
        {
          code: 2593109,
          title: 'History sync is turned off by the business from the WhatsApp Business App',
        },
      ],
    },
  ],
};

const historyMediaValue = {
  messaging_product: 'whatsapp',
  metadata: { display_phone_number: BIZ, phone_number_id: PNID },
  messages: [
    {
      from: USER,
      id: 'wamid.PH1',
      timestamp: '1738796547',
      type: 'image',
      image: { caption: 'Black Prince echeveria', mime_type: 'image/jpeg', sha256: 'abc', id: '24230790383178626' },
    },
  ],
};

const echoValue = {
  messaging_product: 'whatsapp',
  metadata: { display_phone_number: BIZ, phone_number_id: PNID },
  message_echoes: [
    { from: BIZ, to: USER, id: 'wamid.ECHO1', timestamp: '1739321024', type: 'text', text: { body: 'Uygulamadan yanıt' } },
  ],
};

const stateSyncValue = {
  messaging_product: 'whatsapp',
  metadata: { display_phone_number: BIZ, phone_number_id: PNID },
  state_sync: [
    { type: 'contact', contact: { full_name: 'Ayşe Yılmaz', first_name: 'Ayşe', phone_number: '905551112233' }, action: 'add', metadata: { timestamp: '1739321024' } },
    { type: 'contact', contact: { full_name: 'Mehmet Kaya', first_name: 'Mehmet', phone_number: '905554445566' }, action: 'add', metadata: { timestamp: '1739321024' } },
    { type: 'contact', contact: { full_name: 'Silinen Kişi', first_name: 'Silinen', phone_number: '905557778899' }, action: 'remove', metadata: { timestamp: '1739321024' } },
  ],
};

const partnerRemovedPayload = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: WABA,
      time: 1758279420,
      changes: [
        {
          field: 'account_update',
          value: {
            phone_number: BIZ,
            event: 'PARTNER_REMOVED',
            disconnection_info: { reason: 'USER_RE_REGISTERED', initiated_by: 'USER' },
          },
        },
      ],
    },
  ],
};

// --- helpers -------------------------------------------------------------------

type Call = { text: string; params: any[] };

function fakeDb(handler: (text: string, params: any[]) => { rows: any[]; rowCount?: number } | undefined) {
  const calls: Call[] = [];
  return {
    calls,
    query: async (text: string, params: any[] = []) => {
      calls.push({ text, params });
      return handler(text, params) || { rows: [], rowCount: 0 };
    },
  };
}

function baseConnection(overrides: Record<string, any> = {}) {
  return {
    id: 12,
    tenant_id: 7,
    brand_id: 3,
    channel_type: 'WHATSAPP',
    provider: 'META_WHATSAPP_CLOUD',
    status: 'ACTIVE',
    encrypted_credentials: 'enc',
    settings: {
      waba_id: WABA,
      phone_number_id: PNID,
      business_phone_number: '+90 532 317 17 55',
      coexistence: true,
      connection_type: 'WHATSAPP_BUSINESS_APP_ONBOARDING',
    },
    ...overrides,
  };
}

function makeDeps(db: ReturnType<typeof fakeDb>, overrides: Partial<CoexistenceProcessorDeps> = {}) {
  const log = {
    ensure: [] as any[],
    touchOutbound: [] as any[],
    notified: [] as any[],
    afterContacts: [] as number[],
    lookups: [] as number[],
  };
  const deps: CoexistenceProcessorDeps = {
    db,
    findConnectionsByPhoneNumberId: async (pnid) => (pnid === PNID ? [baseConnection()] : []),
    findConnectionsByWabaId: async () => [],
    ensureConversation: async (p) => {
      log.ensure.push(p);
      return { id: 900 };
    },
    touchConversationOutbound: async (p) => {
      log.touchOutbound.push(p);
    },
    resolveContactId: async () => null,
    getRemainingContactQuota: async () => null,
    afterContactsCreated: async (tenantId) => {
      log.afterContacts.push(tenantId);
    },
    notifyConversationUpdated: async (tenantId, conversationId) => {
      log.notified.push({ tenantId, conversationId });
    },
    verifyConnectionCoexistence: async (connection) => {
      log.lookups.push(connection.id);
      return { state: 'UNKNOWN', isOnBizApp: null, platformType: null };
    },
    now: () => new Date('2026-10-22T10:00:00.000Z'),
    ...overrides,
  };
  return { deps, log };
}

function sign(body: string | Buffer, secret: string) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

async function withServer(app: express.Express, fn: (base: string) => Promise<void>) {
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as any;
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

// --- 1. parsers ----------------------------------------------------------------

function parserChecks() {
  const changes = extractCoexistenceChanges(historyPayload);
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].field, 'history');
  assert.strictEqual(changes[0].wabaId, WABA);
  assert.strictEqual(changes[0].phoneNumberId, PNID);
  assert.strictEqual(changes[0].dedupeKey.length, 64);
  assert.strictEqual(
    extractCoexistenceChanges(JSON.parse(JSON.stringify(historyPayload)))[0].dedupeKey,
    changes[0].dedupeKey,
    'identical redelivery → same dedupe key'
  );
  assert.notStrictEqual(
    computeChangeDedupeKey({ field: 'history', wabaId: WABA, entryTime: 1, value: {} }),
    computeChangeDedupeKey({ field: 'history', wabaId: WABA, entryTime: 2, value: {} })
  );

  const mixed = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA,
        changes: [
          { field: 'messages', value: { metadata: { phone_number_id: PNID }, messages: [] } },
          { field: 'smb_message_echoes', value: echoValue },
          { field: 'smb_app_state_sync', value: stateSyncValue },
        ],
      },
    ],
  };
  assert.deepStrictEqual(
    extractCoexistenceChanges(mixed).map((c) => c.field),
    ['smb_message_echoes', 'smb_app_state_sync'],
    'messages field stays on the existing synchronous path'
  );
  assert.deepStrictEqual(extractCoexistenceChanges({ object: 'page', entry: [] }), []);
  assert.deepStrictEqual(collectWebhookRoutingIds(mixed), { phoneNumberIds: [PNID], wabaIds: [WABA] });

  const history = parseHistoryValue(historyPayload.entry[0].changes[0].value);
  assert.strictEqual(history.chunks.length, 1);
  const chunk = history.chunks[0];
  assert.strictEqual(chunk.phase, 0);
  assert.strictEqual(chunk.chunkOrder, 1);
  assert.strictEqual(chunk.progress, 55);
  assert.strictEqual(chunk.declined, false);
  const [out1, ph1, in1] = chunk.messages;
  assert.strictEqual(out1.direction, 'OUTBOUND', 'business-sent history message is outbound');
  assert.strictEqual(out1.counterpartyDigits, USER);
  assert.strictEqual(out1.historyStatus, 'READ');
  assert.strictEqual(ph1.isPlaceholder, true);
  assert.strictEqual(ph1.messageType, 'media_placeholder');
  assert.strictEqual(in1.direction, 'INBOUND');
  assert.strictEqual(in1.counterpartyDigits, USER);
  assert.strictEqual(in1.textBody, 'Teşekkürler');
  assert.strictEqual(in1.timestamp!.toISOString(), new Date(1739230980 * 1000).toISOString());

  const declined = parseHistoryValue(historyDeclinedValue);
  assert.strictEqual(declined.chunks[0].declined, true);

  const media = parseHistoryValue(historyMediaValue);
  assert.strictEqual(media.mediaMessages.length, 1);
  assert.strictEqual(media.mediaMessages[0].direction, 'INBOUND');
  assert.strictEqual(media.mediaMessages[0].textBody, 'Black Prince echeveria');
  assert.strictEqual(media.mediaMessages[0].mediaMetadata!.media_id, '24230790383178626');
  assert.strictEqual(JSON.stringify(media.mediaMessages[0].mediaMetadata).includes('http'), false);

  const echoes = parseMessageEchoes(echoValue);
  assert.strictEqual(echoes.length, 1);
  assert.strictEqual(echoes[0].direction, 'OUTBOUND');
  assert.strictEqual(echoes[0].counterpartyDigits, USER);

  const contacts = parseStateSync(stateSyncValue);
  assert.strictEqual(contacts.length, 3);
  assert.strictEqual(contacts[0].firstName, 'Ayşe');
  assert.strictEqual(contacts[0].lastName, 'Yılmaz');
  assert.strictEqual(contacts[2].action, 'remove');
  assert.deepStrictEqual(splitContactName('Ali Veli Can', null), { firstName: 'Ali Veli', lastName: 'Can' });
  assert.deepStrictEqual(splitContactName('Zeynep', null), { firstName: 'Zeynep', lastName: null });

  const update = parseAccountUpdate(extractCoexistenceChanges(partnerRemovedPayload)[0]);
  assert.strictEqual(update.event, 'PARTNER_REMOVED');
  assert.strictEqual(update.reason, 'USER_RE_REGISTERED');
  assert.strictEqual(update.initiatedBy, 'USER');
  assert.strictEqual(update.phoneDigits, BIZ);
  assert.strictEqual(update.occurredAt!.toISOString(), new Date(1758279420 * 1000).toISOString());
  assert.ok(describeDisconnectReason('USER_RE_REGISTERED').includes('başka bir cihazda'));

  assert.strictEqual(mapHistoryStatusToOutbound('PLAYED'), 'READ');
  assert.strictEqual(mapHistoryStatusToOutbound('DELIVERED'), 'DELIVERED');
  assert.strictEqual(mapHistoryStatusToOutbound('PENDING'), 'SENT');
  assert.strictEqual(mapHistoryStatusToOutbound('ERROR'), 'FAILED');
  console.log('  parsers ok');
}

// --- 2. webhook route (signature, body size, rate limit, persistence) ----------

async function routeChecks() {
  const SECRET = 'test-platform-secret';
  const CONN_SECRET = 'test-connection-secret';
  const state = {
    stored: [] as any[],
    sources: [] as string[],
    messageCalls: 0,
    drains: 0,
    duplicate: false,
  };
  const deps: WhatsAppWebhookRouteDeps = {
    getPlatformAppSecret: () => SECRET,
    getPlatformVerifyToken: () => 'verify-me',
    findConnectionsByVerifyToken: async () => [],
    findConnectionsForSignature: async (ids) =>
      ids.phoneNumberIds.includes('OTHER_PNID') ? [{ encrypted_credentials: 'conn' }] : [],
    unpackAppSecret: (enc) => (enc === 'conn' ? CONN_SECRET : null),
    processMessageEvents: async () => {
      state.messageCalls += 1;
      return { processed: 1 };
    },
    storeCoexistenceChanges: async (changes, source) => {
      state.stored.push(...changes);
      state.sources.push(source);
      return state.duplicate
        ? { stored: 0, duplicates: changes.length }
        : { stored: changes.length, duplicates: 0 };
    },
    scheduleCoexistenceDrain: () => {
      state.drains += 1;
    },
  };

  const app = express();
  app.use('/api/webhooks/whatsapp', createWhatsAppWebhookBodyParser('10mb'));
  app.use(express.json());
  app.use('/api/webhooks/whatsapp', createWhatsAppWebhookRouter(deps));

  await withServer(app, async (base) => {
    const url = `${base}/api/webhooks/whatsapp`;
    const body = JSON.stringify(historyPayload);
    const post = (payload: string, headers: Record<string, string> = {}) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: payload });

    let res = await post(body);
    assert.strictEqual(res.status, 401, 'unsigned request rejected');
    res = await post(body, { 'X-Hub-Signature-256': sign(body, 'wrong-secret') });
    assert.strictEqual(res.status, 401, 'wrong secret rejected');
    const reformatted = JSON.stringify(historyPayload, null, 2);
    res = await post(reformatted, { 'X-Hub-Signature-256': sign(body, SECRET) });
    assert.strictEqual(res.status, 401, 'signature is checked over raw bytes, not re-serialized JSON');
    assert.strictEqual(state.stored.length, 0, 'nothing stored before a valid signature');
    assert.strictEqual(state.drains, 0);

    res = await post(body, { 'X-Hub-Signature-256': sign(body, SECRET) });
    assert.strictEqual(res.status, 200);
    const json: any = await res.json();
    assert.strictEqual(json.stored, 1);
    assert.strictEqual(state.stored[0].field, 'history');
    assert.strictEqual(state.sources[0], 'PLATFORM');
    assert.strictEqual(state.drains, 1, 'async processing scheduled after capture');

    state.duplicate = true;
    res = await post(body, { 'X-Hub-Signature-256': sign(body, SECRET) });
    const dupJson: any = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(dupJson.duplicates, 1);
    assert.strictEqual(state.drains, 1, 'duplicate redelivery does not schedule processing');
    state.duplicate = false;

    const otherPayload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: 'OTHER_WABA', changes: [{ field: 'smb_message_echoes', value: { ...echoValue, metadata: { phone_number_id: 'OTHER_PNID' } } }] }],
    });
    res = await post(otherPayload, { 'X-Hub-Signature-256': sign(otherPayload, CONN_SECRET) });
    assert.strictEqual(res.status, 200, 'per-connection app secret accepted');
    assert.strictEqual(state.sources[state.sources.length - 1], 'CONNECTION');

    const messagesPayload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: WABA, changes: [{ field: 'messages', value: { metadata: { phone_number_id: PNID }, messages: [{ from: USER, id: 'wamid.LIVE', timestamp: '1', type: 'text', text: { body: 'x' } }] } }] }],
    });
    res = await post(messagesPayload);
    assert.strictEqual(res.status, 401);
    assert.strictEqual(state.messageCalls, 0, 'unsigned inbound messages are not processed');
    res = await post(messagesPayload, { 'X-Hub-Signature-256': sign(messagesPayload, SECRET) });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(state.messageCalls, 1, 'existing messages path still processed');

    // ~3 MB history delivery
    const bigThread = Array.from({ length: 12000 }, (_, i) => ({
      from: USER,
      id: `wamid.BIG${i}`,
      timestamp: '1739230980',
      type: 'text',
      text: { body: 'x'.repeat(200) },
    }));
    const big = JSON.parse(JSON.stringify(historyPayload));
    big.entry[0].changes[0].value.history[0].threads[0].messages = bigThread;
    const bigBody = JSON.stringify(big);
    assert.ok(Buffer.byteLength(bigBody) > 2 * 1024 * 1024);
    res = await post(bigBody, { 'X-Hub-Signature-256': sign(bigBody, SECRET) });
    assert.strictEqual(res.status, 200, 'large history body accepted');

    const verify = await fetch(`${url}?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42`);
    assert.strictEqual(verify.status, 200);
    assert.strictEqual(await verify.text(), '42');
  });

  // Global parser alone (100kb default) would reject the same body → dedicated parser is required.
  const plain = express();
  plain.use(express.json());
  plain.post('/x', (_req, res) => res.json({ ok: true }));
  await withServer(plain, async (base) => {
    const res = await fetch(`${base}/x`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(200 * 1024) }),
    });
    assert.strictEqual(res.status, 413);
  });

  // Dedicated limiter
  const limited = express();
  limited.use('/api/webhooks/whatsapp', createWhatsAppWebhookRateLimiter({ max: 2, windowMs: 60000 }));
  limited.post('/api/webhooks/whatsapp', (_req, res) => res.sendStatus(200));
  await withServer(limited, async (base) => {
    const codes: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      codes.push((await fetch(`${base}/api/webhooks/whatsapp`, { method: 'POST' })).status);
    }
    assert.deepStrictEqual(codes, [200, 200, 429]);
  });
  assert.strictEqual(isWhatsAppWebhookPath('/api/webhooks/whatsapp'), true);
  assert.strictEqual(isWhatsAppWebhookPath('/api/webhooks/whatsapp/meta?x=1'), true);
  assert.strictEqual(isWhatsAppWebhookPath('/api/webhooks/whatsappx'), false);
  assert.strictEqual(isWhatsAppWebhookPath('/api/channel-connections'), false);

  await productionMessagesCompatibilityChecks();

  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8');
  assert.ok(serverSrc.includes('skip: (req) => isWhatsAppWebhookPath(req.originalUrl)'), 'global limiter skips webhook');
  const parserIdx = serverSrc.indexOf('createWhatsAppWebhookBodyParser()');
  const globalJsonIdx = serverSrc.indexOf('app.use(express.json({');
  assert.ok(parserIdx > 0 && parserIdx < globalJsonIdx, 'webhook parser mounted before global JSON parser');
  console.log('  webhook route ok');
}

/** The live messages/statuses flow must behave as before the coexistence change. */
async function productionMessagesCompatibilityChecks() {
  const SECRET = 'prod-like-platform-secret';
  const CONN_SECRET = 'prod-like-connection-secret';
  let platformSecret = SECRET;
  let storeFails = false;
  const seen: { events: any[]; stored: number } = { events: [], stored: 0 };
  const deps: WhatsAppWebhookRouteDeps = {
    getPlatformAppSecret: () => platformSecret,
    getPlatformVerifyToken: () => 'verify-me',
    findConnectionsByVerifyToken: async () => [],
    findConnectionsForSignature: async (ids) =>
      ids.phoneNumberIds.includes(PNID) || ids.wabaIds.includes(WABA) ? [{ encrypted_credentials: 'conn' }] : [],
    unpackAppSecret: (enc) => (enc === 'conn' ? CONN_SECRET : null),
    processMessageEvents: async (p) => {
      seen.events.push(...p.events);
      return { processed: p.events.length };
    },
    storeCoexistenceChanges: async (changes) => {
      if (storeFails) throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
      seen.stored += changes.length;
      return { stored: changes.length, duplicates: 0 };
    },
    scheduleCoexistenceDrain: () => undefined,
  };

  // Same mounting as server.ts (dedicated parser, then global parser, both mount paths).
  const app = express();
  app.use('/api/webhooks/whatsapp', createWhatsAppWebhookBodyParser());
  app.use(express.json());
  const router = createWhatsAppWebhookRouter(deps);
  app.use('/api/webhooks/whatsapp/meta', router);
  app.use('/api/webhooks/whatsapp', router);

  // Raw bytes as Meta sends them: escaped slashes and \u escapes that re-serialization would change.
  const inboundRaw =
    '{"object":"whatsapp_business_account","entry":[{"id":"' + WABA + '","changes":[{"value":{"messaging_product":"whatsapp",' +
    '"metadata":{"display_phone_number":"' + BIZ + '","phone_number_id":"' + PNID + '"},' +
    '"contacts":[{"profile":{"name":"\\u015e\\u00fckr\\u00fc \\ud83d\\ude00"},"wa_id":"' + USER + '"}],' +
    '"messages":[{"from":"' + USER + '","id":"wamid.PROD1","timestamp":"1761200000","type":"text",' +
    '"text":{"body":"Merhaba https:\\/\\/ornek.com \\u00e7\\u00f6z\\u00fcm"}}]},"field":"messages"}]}]}';
  assert.notStrictEqual(JSON.stringify(JSON.parse(inboundRaw)), inboundRaw, 'fixture differs from re-serialized form');
  const statusRaw = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: WABA, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp',
      metadata: { display_phone_number: BIZ, phone_number_id: PNID },
      statuses: [{ id: 'wamid.SENT1', status: 'delivered', timestamp: '1761200001', recipient_id: USER }] } }] }],
  });

  await withServer(app, async (base) => {
    const post = (p: string, body: string, headers: Record<string, string> = {}) =>
      fetch(`${base}${p}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
        body,
      });

    let res = await post('/api/webhooks/whatsapp', inboundRaw, { 'X-Hub-Signature-256': sign(inboundRaw, SECRET) });
    assert.strictEqual(res.status, 200, 'Meta-signed inbound with escapes accepted');
    const inbound = seen.events.find((e) => e.kind === 'inbound');
    assert.ok(inbound && inbound.providerMessageId === 'wamid.PROD1' && inbound.phoneNumberId === PNID);
    assert.ok(String(inbound.textBody || '').includes('https://ornek.com çözüm'));

    res = await post('/api/webhooks/whatsapp/meta', statusRaw, { 'X-Hub-Signature-256': sign(statusRaw, SECRET) });
    assert.strictEqual(res.status, 200, '/meta mount path still works');
    assert.ok(seen.events.some((e) => e.kind === 'status' && e.providerMessageId === 'wamid.SENT1'), 'delivery statuses processed');
    assert.strictEqual(seen.stored, 0, 'messages field never enters the coexistence store');

    // Header name case-insensitive, as before.
    res = await post('/api/webhooks/whatsapp', statusRaw, { 'x-hub-signature-256': sign(statusRaw, SECRET) });
    assert.strictEqual(res.status, 200);

    // Without a platform secret: per-connection secret works, a wrong one is rejected (as before).
    platformSecret = '';
    res = await post('/api/webhooks/whatsapp', inboundRaw, { 'X-Hub-Signature-256': sign(inboundRaw, CONN_SECRET) });
    assert.strictEqual(res.status, 200, 'per-connection secret still accepted');
    const before = seen.events.length;
    res = await post('/api/webhooks/whatsapp', inboundRaw, { 'X-Hub-Signature-256': sign(inboundRaw, 'forged') });
    assert.strictEqual(res.status, 401, 'known number + wrong signature rejected');

    // Unknown number and no secret to check against: acknowledged like before, but nothing processed.
    const unknownRaw = inboundRaw.split(PNID).join('000000000000000').split(WABA).join('111111111111111');
    res = await post('/api/webhooks/whatsapp', unknownRaw, { 'X-Hub-Signature-256': sign(unknownRaw, 'anything') });
    assert.strictEqual(res.status, 200, 'unknown target keeps the previous 200 response');
    assert.strictEqual(seen.events.length, before, 'unverifiable request is not processed');
    platformSecret = SECRET;

    // Mixed payload while the coexistence table is missing: messages still processed, 500 for redelivery.
    storeFails = true;
    const mixedRaw = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: WABA, changes: [
        JSON.parse(inboundRaw).entry[0].changes[0],
        { field: 'smb_message_echoes', value: echoValue },
      ] }],
    });
    const countBefore = seen.events.length;
    res = await post('/api/webhooks/whatsapp', mixedRaw, { 'X-Hub-Signature-256': sign(mixedRaw, SECRET) });
    assert.strictEqual(res.status, 500, 'coexistence capture failure is surfaced so Meta redelivers');
    assert.ok(seen.events.length > countBefore, 'messages were processed before the coexistence store');
    storeFails = false;
  });
  console.log('  production messages compatibility ok');
}

// --- 3. persistence + processors -----------------------------------------------

async function accountUpdateIsolationChecks(nonCoexistenceSameWaba: any) {
  assert.strictEqual(classifyCoexistenceLookup({ isOnBizApp: true, platformType: 'CLOUD_API' }), 'COEXISTENCE_ACTIVE');
  assert.strictEqual(classifyCoexistenceLookup({ isOnBizApp: false, platformType: 'CLOUD_API' }), 'CLOUD_ONLY');
  assert.strictEqual(classifyCoexistenceLookup({ isOnBizApp: true, platformType: 'NOT_APPLICABLE' }), 'NOT_ON_CLOUD_API');
  assert.strictEqual(classifyCoexistenceLookup({ isOnBizApp: null, platformType: 'CLOUD_API' }), 'UNKNOWN');
  assert.strictEqual(classifyCoexistenceLookup({ isOnBizApp: false, platformType: null }), 'UNKNOWN');
  assert.strictEqual(classifyCoexistenceLookup(null), 'UNKNOWN');

  // Same WABA: connection 12 (tenant 7, coexistence), 50 (tenant 9, coexistence, other number),
  // 99 (tenant 8, plain Cloud API). Connections of other WABAs are never loaded.
  const c12 = () => baseConnection();
  const c50 = () =>
    baseConnection({
      id: 50,
      tenant_id: 9,
      settings: {
        waba_id: WABA,
        phone_number_id: 'P50',
        business_phone_number: '+90 555 000 50 50',
        coexistence: true,
        connection_type: 'WHATSAPP_BUSINESS_APP_ONBOARDING',
      },
    });
  const live = (map: Record<number, CoexistenceLiveCheck['state']>) => async (connection: any) => {
    const state = map[connection.id] || 'UNKNOWN';
    return {
      state,
      isOnBizApp: state === 'COEXISTENCE_ACTIVE' ? true : state === 'CLOUD_ONLY' ? false : null,
      platformType: state === 'NOT_ON_CLOUD_API' ? 'NOT_APPLICABLE' : state === 'UNKNOWN' ? null : 'CLOUD_API',
    };
  };
  const updateDb = () =>
    fakeDb((text) => (text.includes('UPDATE channel_connections') ? { rows: [], rowCount: 1 } : undefined));
  const updates = (db: ReturnType<typeof fakeDb>) => db.calls.filter((c) => c.text.includes('UPDATE channel_connections'));
  const offboarded = { wabaId: WABA, value: { event: 'ACCOUNT_OFFBOARDED' }, entryTime: 1768477204 };
  const wabaLookups: Array<string> = [];
  const sameWaba = async (waba: string) => {
    wabaLookups.push(waba);
    return waba === WABA ? [c12(), c50(), nonCoexistenceSameWaba] : [];
  };

  // phone-pinned PARTNER_REMOVED: no Meta lookup, only the matching number
  {
    const db = updateDb();
    const { deps, log } = makeDeps(db, { findConnectionsByWabaId: sameWaba });
    const change = extractCoexistenceChanges(partnerRemovedPayload)[0];
    await processAccountUpdate({ wabaId: WABA, value: change.value, entryTime: change.entryTime }, deps);
    assert.deepStrictEqual(updates(db).map((c) => c.params[1]), [12]);
    assert.strictEqual(log.lookups.length, 0, 'payload phone number needs no lookup');
  }

  // ACCOUNT_OFFBOARDED without phone: each coexistence connection verified separately
  {
    const db = updateDb();
    const { deps, log } = makeDeps(db, {
      findConnectionsByWabaId: sameWaba,
      verifyConnectionCoexistence: async (c) => {
        log.lookups.push(c.id);
        return live({ 12: 'NOT_ON_CLOUD_API', 50: 'COEXISTENCE_ACTIVE' })(c);
      },
    });
    await assert.rejects(
      processAccountUpdate(offboarded, deps),
      (e: any) => e instanceof CoexistenceVerificationPendingError && /bağlantı 50=COEXISTENCE_ACTIVE/.test(e.message)
    );
    assert.deepStrictEqual(log.lookups.sort(), [12, 50], 'plain Cloud API connection is never queried');
    assert.deepStrictEqual(updates(db).map((c) => [c.params[1], c.params[2]]), [[12, 7]], 'only the confirmed connection changes');
    const patch = JSON.parse(updates(db)[0].params[0]);
    assert.strictEqual(patch.coexistence_status, 'DISCONNECTED');
    assert.strictEqual(patch.platform_type, 'NOT_APPLICABLE');
    assert.ok(patch.coexistence_verified_at);
  }

  // all lookups uncertain (errors / token rejected / missing fields): nothing changes
  {
    const db = updateDb();
    const { deps } = makeDeps(db, {
      findConnectionsByWabaId: sameWaba,
      verifyConnectionCoexistence: async () => {
        throw new Error('network down');
      },
    });
    await assert.rejects(processAccountUpdate(offboarded, deps), CoexistenceVerificationPendingError);
    assert.strictEqual(updates(db).length, 0, 'uncertain → existing states untouched');
  }

  // every coexistence connection confirmed offboarded: each updated under its own tenant
  {
    const db = updateDb();
    const { deps } = makeDeps(db, {
      findConnectionsByWabaId: sameWaba,
      verifyConnectionCoexistence: live({ 12: 'NOT_ON_CLOUD_API', 50: 'NOT_ON_CLOUD_API' }),
    });
    const res = await processAccountUpdate(offboarded, deps);
    assert.strictEqual(res.status, 'PROCESSED');
    assert.deepStrictEqual(
      updates(db).map((c) => [c.params[1], c.params[2]]).sort((a, b) => a[0] - b[0]),
      [[12, 7], [50, 9]]
    );
    assert.ok(updates(db).every((c) => /WHERE id = \$2 AND tenant_id = \$3/.test(c.text)));
  }

  // retry after partial success: already-applied connection is not re-queried
  {
    const db = updateDb();
    const applied = c12();
    applied.settings = {
      ...applied.settings,
      coexistence_status: 'DISCONNECTED',
      coexistence_status_at: new Date(1768477204 * 1000).toISOString(),
    } as any;
    const { deps, log } = makeDeps(db, {
      findConnectionsByWabaId: async () => [applied, c50()],
      verifyConnectionCoexistence: async (c) => {
        log.lookups.push(c.id);
        return live({ 50: 'NOT_ON_CLOUD_API' })(c);
      },
    });
    const res = await processAccountUpdate(offboarded, deps);
    assert.strictEqual(res.status, 'PROCESSED');
    assert.deepStrictEqual(log.lookups, [50]);
    assert.deepStrictEqual(updates(db).map((c) => c.params[1]), [50]);
  }

  // ACCOUNT_RECONNECTED: only connections confirmed back on coexistence flip to CONNECTED
  {
    const db = updateDb();
    const { deps } = makeDeps(db, {
      findConnectionsByWabaId: sameWaba,
      verifyConnectionCoexistence: live({ 12: 'COEXISTENCE_ACTIVE', 50: 'CLOUD_ONLY' }),
    });
    await assert.rejects(
      processAccountUpdate({ wabaId: WABA, value: { event: 'ACCOUNT_RECONNECTED' }, entryTime: 1768477203 }, deps),
      CoexistenceVerificationPendingError
    );
    assert.deepStrictEqual(updates(db).map((c) => c.params[1]), [12]);
    assert.strictEqual(JSON.parse(updates(db)[0].params[0]).coexistence_status, 'CONNECTED');
  }

  // untracked events, missing WABA, unknown WABA: no writes, no lookups
  {
    const db = updateDb();
    const { deps, log } = makeDeps(db, { findConnectionsByWabaId: sameWaba });
    assert.strictEqual((await processAccountUpdate({ wabaId: WABA, value: { event: 'VERIFIED_ACCOUNT' }, entryTime: 1 }, deps)).status, 'IGNORED');
    assert.strictEqual((await processAccountUpdate({ ...offboarded, wabaId: null }, deps)).status, 'IGNORED');
    assert.strictEqual((await processAccountUpdate({ ...offboarded, wabaId: '999' }, deps)).status, 'IGNORED');
    assert.strictEqual(db.calls.length, 0);
    assert.strictEqual(log.lookups.length, 0);
    assert.ok(wabaLookups.every((w) => w === WABA || w === '999'), 'connections are loaded only for the event WABA');
  }

  // pending verification leaves the raw event FAILED (bounded retry), never PROCESSED
  {
    let claimed = false;
    const db = fakeDb((text) => {
      if (text.includes('UPDATE whatsapp_webhook_events e')) {
        if (claimed) return { rows: [] };
        claimed = true;
        return {
          rows: [{ id: 77, field: 'account_update', event_name: 'ACCOUNT_OFFBOARDED', waba_id: WABA, phone_number_id: null,
            payload: { entry_time: 1768477204, value: { event: 'ACCOUNT_OFFBOARDED' } } }],
        };
      }
      return undefined;
    });
    const { deps } = makeDeps(db, { findConnectionsByWabaId: sameWaba });
    const drained = await drainCoexistenceEvents(deps);
    assert.deepStrictEqual(drained, { processed: 0, failed: 1 });
    const failedCall = db.calls.find((c) => c.text.includes("SET status = 'FAILED'"));
    assert.ok(failedCall && /durum değiştirilmedi/.test(failedCall.params[1]));
    assert.ok(!db.calls.some((c) => c.text.includes('UPDATE channel_connections')));
  }

  const root = path.join(__dirname, '..');
  const runtime = fs.readFileSync(path.join(root, 'services', 'whatsappCoexistenceRuntime.ts'), 'utf8');
  assert.ok(runtime.includes('fetchPhoneCoexistenceStatus({ accessToken, phoneNumberId })'), 'verification uses the read-only lookup');
  const signupSvc = fs.readFileSync(path.join(root, 'services', 'metaEmbeddedSignupService.ts'), 'utf8');
  const lookupFn = signupSvc.slice(signupSvc.indexOf('export async function fetchPhoneCoexistenceStatus'));
  const lookupEnd = lookupFn.search(/\r?\n}\r?\n/);
  assert.ok(lookupEnd > 0);
  const lookupBody = lookupFn.slice(0, lookupEnd);
  assert.ok(lookupBody.includes('?fields=is_on_biz_app,platform_type'));
  assert.ok(!/method:\s*'(POST|DELETE|PUT)'/.test(lookupBody), 'coexistence lookup is GET only');
  console.log('  account_update isolation ok');
}

async function processorChecks() {
  // store: ON CONFLICT dedupe
  const storeDb = fakeDb((text, params) => {
    if (text.includes('INSERT INTO whatsapp_webhook_events')) {
      return params[0] === 'dup' ? { rows: [] } : { rows: [{ id: 1 }] };
    }
    return undefined;
  });
  const changes = extractCoexistenceChanges(historyPayload);
  const stored = await storeCoexistenceChanges(storeDb, [...changes, { ...changes[0], dedupeKey: 'dup' }], 'PLATFORM');
  assert.deepStrictEqual({ stored: stored.stored, duplicates: stored.duplicates }, { stored: 1, duplicates: 1 });
  assert.ok(storeDb.calls[0].text.includes('ON CONFLICT (dedupe_key) DO NOTHING'));

  // account_update: only the matching coexistence connection of the WABA is updated
  const auDb = fakeDb((text) => (text.includes('UPDATE channel_connections') ? { rows: [], rowCount: 1 } : undefined));
  const other = baseConnection({ id: 99, tenant_id: 8, settings: { waba_id: WABA, phone_number_id: 'X', business_phone_number: '+1 555 000 1111' } });
  const { deps: auDeps } = makeDeps(auDb, { findConnectionsByWabaId: async () => [baseConnection(), other] });
  const auChange = extractCoexistenceChanges(partnerRemovedPayload)[0];
  const au = await processAccountUpdate({ wabaId: WABA, value: auChange.value, entryTime: auChange.entryTime }, auDeps);
  assert.strictEqual(au.status, 'PROCESSED');
  assert.strictEqual(auDb.calls.length, 1, 'other customers on the same WABA are untouched');
  const patch = JSON.parse(auDb.calls[0].params[0]);
  assert.strictEqual(auDb.calls[0].params[1], 12);
  assert.strictEqual(patch.coexistence_status, 'DISCONNECTED');
  assert.strictEqual(patch.coexistence_disconnection.reason, 'USER_RE_REGISTERED');
  assert.strictEqual(patch.coexistence_disconnection.initiated_by, 'USER');
  assert.strictEqual(patch.coexistence_disconnection.occurred_at, new Date(1758279420 * 1000).toISOString());
  assert.ok(auDb.calls[0].text.includes("COALESCE(settings->>'coexistence_status_at', '') <= $4"), 'out-of-order guard');
  assert.ok(!auDb.calls[0].text.includes('encrypted_credentials'), 'disconnect never touches credentials');
  assert.ok(!auDb.calls[0].text.includes('status ='), 'disconnect does not flip connection status');

  await accountUpdateIsolationChecks(other);

  // echoes: outbound record, no queue, no credit
  const echoDb = fakeDb((text) => {
    if (text.includes('INSERT INTO outbound_messages')) return { rows: [{ id: 501, conversation_id: null, inserted: true }] };
    return undefined;
  });
  const { deps: echoDeps, log: echoLog } = makeDeps(echoDb);
  const echoRes = await processMessageEchoes({ phoneNumberId: PNID, value: echoValue }, echoDeps);
  assert.strictEqual(echoRes.status, 'PROCESSED');
  const insert = echoDb.calls.find((c) => c.text.includes('INSERT INTO outbound_messages'))!;
  assert.ok(insert.text.includes('false, $9::text'), 'usage_reserved=false');
  assert.strictEqual(insert.params[4], 'SENT');
  assert.strictEqual(insert.params[5], 'wa-coex:wamid.ECHO1');
  assert.strictEqual(insert.params[6], 'wamid.ECHO1');
  assert.strictEqual(insert.params[8], 'BUSINESS_APP_ECHO');
  assert.strictEqual(JSON.parse(insert.params[2]).to, `+${USER}`);
  assert.ok(insert.text.includes('ON CONFLICT (tenant_id, idempotency_key)'), 'echo redelivery deduped');
  assert.ok(insert.text.includes('provider_message_id = $7::text AND idempotency_key <> $6::text'), 'API-sent wamid never duplicated');
  assert.strictEqual(echoLog.ensure[0].createStatus, 'OPEN');
  assert.strictEqual(echoLog.touchOutbound.length, 1);
  assert.strictEqual(echoLog.notified.length, 1);

  const dupDb = fakeDb(() => ({ rows: [] }));
  const { deps: dupDeps, log: dupLog } = makeDeps(dupDb);
  await processMessageEchoes({ phoneNumberId: PNID, value: echoValue }, dupDeps);
  assert.strictEqual(dupLog.ensure.length, 0, 'duplicate echo does not touch conversations');

  const processorSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'whatsappCoexistenceProcessor.ts'), 'utf8');
  assert.ok(!/enqueue|outboundQueue|incrementUsage|reserveUsage|createOutboundMessage/.test(processorSrc), 'processor never queues or bills');

  // history: inbound + outbound import, RESOLVED conversations, progress tracking
  const histDb = fakeDb((text) => {
    if (text.includes('INSERT INTO inbound_messages')) return { rows: [{ id: 601, conversation_id: null, inserted: true }] };
    if (text.includes('INSERT INTO outbound_messages')) return { rows: [{ id: 602, conversation_id: null, inserted: true }] };
    return undefined;
  });
  const { deps: histDeps, log: histLog } = makeDeps(histDb);
  const hist = await processHistory({ phoneNumberId: PNID, value: historyPayload.entry[0].changes[0].value }, histDeps);
  assert.strictEqual(hist.status, 'PROCESSED');
  const outInserts = histDb.calls.filter((c) => c.text.includes('INSERT INTO outbound_messages'));
  const inInserts = histDb.calls.filter((c) => c.text.includes('INSERT INTO inbound_messages'));
  assert.strictEqual(outInserts.length, 2, 'two business-sent history messages');
  assert.strictEqual(inInserts.length, 1, 'one customer history message');
  assert.strictEqual(outInserts[0].params[4], 'READ');
  assert.strictEqual(outInserts[0].params[8], 'HISTORY_SYNC');
  assert.ok(inInserts[0].text.includes("'PROCESSED','HISTORY_SYNC'"));
  assert.ok(inInserts[0].text.includes("WHERE inbound_messages.message_type = 'media_placeholder'"), 'placeholder upgrade only');
  assert.ok(histLog.ensure.every((e) => e.createStatus === 'RESOLVED'), 'history never opens new inbox items');
  assert.strictEqual(histLog.touchOutbound.length, 0, 'history does not change conversation status');
  const progress = histDb.calls.find((c) => c.text.includes('UPDATE whatsapp_coexistence_sync_requests'))!;
  assert.strictEqual(progress.params[1], 'HISTORY');
  assert.strictEqual(progress.params[2], 55);
  assert.strictEqual(progress.params[3], 0);
  assert.strictEqual(progress.params[5], 3);
  assert.strictEqual(progress.params[8], false);

  const decDb = fakeDb(() => undefined);
  const { deps: decDeps } = makeDeps(decDb);
  await processHistory({ phoneNumberId: PNID, value: historyDeclinedValue }, decDeps);
  const decUpdate = decDb.calls.find((c) => c.text.includes('UPDATE whatsapp_coexistence_sync_requests'))!;
  assert.strictEqual(decUpdate.params[8], true, '2593109 recorded as DECLINED');
  assert.ok(decUpdate.text.includes("'2593109'"));

  const unknown = await processHistory({ phoneNumberId: 'UNKNOWN', value: {} }, decDeps);
  assert.strictEqual(unknown.status, 'IGNORED');

  // contacts: create / enrich / quota / remove
  const contactDb = fakeDb((text) => {
    if (text.includes('INSERT INTO contacts')) return { rows: [{ id: 801 }] };
    if (text.includes('INSERT INTO contact_points')) return { rows: [{ id: 802 }] };
    if (text.includes('UPDATE contacts')) return { rows: [], rowCount: 1 };
    return undefined;
  });
  const { deps: cDeps, log: cLog } = makeDeps(contactDb, {
    resolveContactId: async (_t, phone) => (phone === '+905551112233' ? 55 : null),
    getRemainingContactQuota: async () => 1,
  });
  const cRes: any = await processStateSync({ phoneNumberId: PNID, value: stateSyncValue }, cDeps);
  const summary = cRes.summary.connections[0];
  assert.strictEqual(summary.enriched, 1, 'existing contact only gets empty names filled');
  assert.strictEqual(summary.created, 1);
  assert.strictEqual(summary.removed_ignored, 1, 'address-book removal never deletes CRM contacts');
  assert.ok(!contactDb.calls.some((c) => /DELETE FROM contacts/.test(c.text)));
  assert.ok(contactDb.calls.some((c) => c.text.includes('INSERT INTO contact_brand_links')));
  assert.deepStrictEqual(cLog.afterContacts, [7]);

  const quotaDb = fakeDb(() => undefined);
  const { deps: qDeps } = makeDeps(quotaDb, { getRemainingContactQuota: async () => 0 });
  const qRes: any = await processStateSync({ phoneNumberId: PNID, value: stateSyncValue }, qDeps);
  assert.strictEqual(qRes.summary.connections[0].skipped_quota, 2, 'plan contact quota respected');
  assert.ok(!quotaDb.calls.some((c) => c.text.includes('INSERT INTO contacts')));

  // drain: processed → PROCESSED, failure → FAILED (retried later)
  let claimed = false;
  const drainDb = fakeDb((text) => {
    if (text.includes("SET status = 'PROCESSING'")) {
      if (claimed) return { rows: [] };
      claimed = true;
      return {
        rows: [
          { id: 2, field: 'smb_message_echoes', phone_number_id: PNID, payload: { value: echoValue } },
          { id: 1, field: 'history', phone_number_id: PNID, payload: { value: historyPayload.entry[0].changes[0].value } },
        ],
      };
    }
    if (text.includes('INSERT INTO outbound_messages')) return { rows: [{ id: 1, inserted: true }] };
    if (text.includes('INSERT INTO inbound_messages')) throw new Error('boom');
    return undefined;
  });
  const { deps: drainDeps } = makeDeps(drainDb);
  const drained = await drainCoexistenceEvents(drainDeps);
  assert.deepStrictEqual(drained, { processed: 1, failed: 1 });
  const marks = drainDb.calls.filter((c) => c.text.includes('UPDATE whatsapp_webhook_events'));
  assert.ok(marks.some((c) => c.text.includes("status = 'FAILED'") && c.params[0] === 1));
  assert.ok(marks.some((c) => c.params[0] === 2 && c.params[1] === 'PROCESSED'));
  console.log('  processors ok');
}

// --- 4. sync trigger guard -------------------------------------------------------

async function syncChecks() {
  const now = new Date('2026-10-22T10:00:00.000Z');
  const onboarded = '2026-10-22T08:00:00.000Z';
  const conn = baseConnection({
    settings: { ...baseConnection().settings, coexistence_onboarded_at: onboarded, api_version: 'v23.0' },
  });

  assert.strictEqual(evaluateCoexistenceSyncEligibility(conn, now).ok, true);
  const manual = evaluateCoexistenceSyncEligibility(
    baseConnection({ settings: { waba_id: WABA, phone_number_id: PNID, connection_method: 'MANUAL' } }),
    now
  ) as any;
  assert.strictEqual(manual.code, 'NOT_COEXISTENCE');
  const expired = evaluateCoexistenceSyncEligibility(conn, new Date('2026-10-23T08:00:01.000Z')) as any;
  assert.strictEqual(expired.code, 'WINDOW_EXPIRED');
  const dropped = evaluateCoexistenceSyncEligibility(
    baseConnection({
      settings: {
        ...conn.settings,
        coexistence_status: 'DISCONNECTED',
        coexistence_status_at: '2026-10-22T09:00:00.000Z',
      },
    }),
    now
  ) as any;
  assert.strictEqual(dropped.code, 'DISCONNECTED');

  const rows: Record<string, any> = {};
  const metaCalls: any[] = [];
  let metaResult: any = { ok: true, requestId: 'REQ-1' };
  const db = fakeDb((text, params) => {
    if (text.includes('FROM channel_connections WHERE id = $1')) return { rows: [conn] };
    if (text.includes('INSERT INTO whatsapp_coexistence_sync_requests')) {
      const key = `${params[3]}:${params[4]}`;
      const existing = rows[key];
      const retryable = existing && !existing.request_id && (existing.status === 'FAILED' || (existing.status === 'UNCERTAIN' && params[6]));
      if (existing && !retryable) return { rows: [] };
      rows[key] = { id: 1, sync_type: params[4], onboarding_key: params[3], status: 'REQUESTING', request_id: null, attempts: (existing?.attempts || 0) + 1 };
      return { rows: [rows[key]] };
    }
    if (text.includes('SELECT * FROM whatsapp_coexistence_sync_requests')) {
      return { rows: Object.values(rows).filter((r: any) => r.sync_type === params[2]) };
    }
    if (text.includes('request_id = $2')) {
      const row = Object.values(rows).find((r: any) => r.id === params[0]) as any;
      row.status = 'REQUESTED';
      row.request_id = params[1];
      return { rows: [row] };
    }
    if (text.includes('SET status = $2, last_error_code = $3')) {
      const row = Object.values(rows).find((r: any) => r.status === 'REQUESTING') as any;
      row.status = params[1];
      row.last_error_code = params[2];
      return { rows: [row] };
    }
    return undefined;
  });
  const deps = {
    db,
    unpackAccessToken: () => 'TOKEN',
    callSmbAppData: async (p: any) => {
      metaCalls.push(p);
      return metaResult;
    },
    now: () => now,
  };

  const ok = await requestCoexistenceSync({ tenantId: 7, connectionId: 12, syncType: 'CONTACTS', userId: 1 }, deps);
  assert.strictEqual(ok.sync!.status, 'REQUESTED');
  assert.strictEqual(ok.sync!.requestId, 'REQ-1');
  assert.strictEqual(metaCalls[0].syncType, 'smb_app_state_sync');
  assert.strictEqual(metaCalls[0].phoneNumberId, PNID);

  let err: any = null;
  try {
    await requestCoexistenceSync({ tenantId: 7, connectionId: 12, syncType: 'CONTACTS', userId: 1 }, deps);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof CoexistenceSyncError);
  assert.strictEqual(err.httpStatus, 409);
  assert.strictEqual(err.code, 'SYNC_ALREADY_REQUESTED');
  assert.strictEqual(metaCalls.length, 1, 'second request never reaches Meta');

  metaResult = { ok: false, uncertain: false, status: 400, metaCode: '100', message: 'Invalid parameter' };
  err = null;
  try {
    await requestCoexistenceSync({ tenantId: 7, connectionId: 12, syncType: 'HISTORY', userId: 1 }, deps);
  } catch (e) {
    err = e;
  }
  assert.strictEqual(err.code, 'META_REJECTED');
  assert.strictEqual(metaCalls[1].syncType, 'history');
  assert.strictEqual(rows[`${onboarded}:HISTORY`].status, 'FAILED');

  metaResult = { ok: false, uncertain: true, status: 0, metaCode: null, message: 'timeout' };
  err = null;
  try {
    await requestCoexistenceSync({ tenantId: 7, connectionId: 12, syncType: 'HISTORY', userId: 1 }, deps);
  } catch (e) {
    err = e;
  }
  assert.strictEqual(err.code, 'SYNC_UNCERTAIN', 'definitive failure may be retried; timeout becomes UNCERTAIN');
  assert.strictEqual(metaCalls.length, 3);

  err = null;
  try {
    await requestCoexistenceSync({ tenantId: 7, connectionId: 12, syncType: 'HISTORY', userId: 1 }, deps);
  } catch (e) {
    err = e;
  }
  assert.strictEqual(err.code, 'SYNC_UNCERTAIN');
  assert.strictEqual(metaCalls.length, 3, 'UNCERTAIN blocks silent retry');

  metaResult = { ok: true, requestId: 'REQ-2' };
  const retried = await requestCoexistenceSync(
    { tenantId: 7, connectionId: 12, syncType: 'HISTORY', userId: 1, confirmRetry: true },
    deps
  );
  assert.strictEqual(retried.sync!.requestId, 'REQ-2');

  const status = await getCoexistenceStatus({ tenantId: 7, connectionId: 12 }, deps);
  assert.strictEqual(status.syncDeadline, '2026-10-23T08:00:00.000Z');
  assert.strictEqual(status.eligibility.ok, true);

  // Graph request shape (stubbed fetch, no network)
  const realFetch = globalThis.fetch;
  const seen: any[] = [];
  (globalThis as any).fetch = async (url: string, init: any) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ messaging_product: 'whatsapp', request_id: 'RID' }), { status: 200 });
  };
  try {
    const r = await requestSmbAppDataSync({ accessToken: 'T', phoneNumberId: PNID, syncType: 'history', apiVersion: 'v23.0' });
    assert.deepStrictEqual(r, { ok: true, requestId: 'RID' });
    assert.strictEqual(seen[0].url, `https://graph.facebook.com/v23.0/${PNID}/smb_app_data`);
    assert.strictEqual(seen[0].init.method, 'POST');
    assert.deepStrictEqual(JSON.parse(seen[0].init.body), { messaging_product: 'whatsapp', sync_type: 'history' });
    assert.strictEqual(seen[0].init.headers.Authorization, 'Bearer T');
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ error: { code: 100, message: 'bad' } }), { status: 400 });
    const bad: any = await requestSmbAppDataSync({ accessToken: 'T', phoneNumberId: PNID, syncType: 'smb_app_state_sync' });
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.uncertain, false);
    assert.strictEqual(bad.metaCode, '100');
  } finally {
    (globalThis as any).fetch = realFetch;
  }
  console.log('  sync guard ok');
}

// --- 5. reconnect settings + regression guards -----------------------------------

function settingsAndRegressionChecks() {
  const now = new Date('2026-10-22T10:00:00.000Z');
  const existing = {
    waba_id: WABA,
    phone_number_id: PNID,
    business_phone_number: '+90 532 317 17 55',
    default_sender: true,
    custom_operator_flag: 'keep-me',
    last_inbound_at: '2026-09-19T10:57:00.000Z',
    last_error: 'old',
    coexistence_onboarded_at: '2026-01-01T00:00:00.000Z',
    coexistence_disconnection: { reason: 'USER_RE_REGISTERED' },
  };
  const fresh = {
    waba_id: WABA,
    phone_number_id: PNID,
    business_phone_number: '+90 532 317 17 55',
    verified_name: null,
    connection_method: 'EMBEDDED_SIGNUP',
    connection_type: 'WHATSAPP_BUSINESS_APP_ONBOARDING',
    coexistence: true,
    last_inbound_at: null,
    last_outbound_at: null,
    last_error: null,
  };
  const merged = mergeReconnectSettings({
    existing,
    fresh,
    coexistence: true,
    now,
    isOnBizApp: true,
    platformType: 'CLOUD_API',
    credentialsRotated: true,
  });
  assert.strictEqual(merged.custom_operator_flag, 'keep-me');
  assert.strictEqual(merged.default_sender, true);
  assert.strictEqual(merged.last_inbound_at, '2026-09-19T10:57:00.000Z', 'fresh null never erases history');
  assert.strictEqual(merged.last_error, null);
  assert.strictEqual(merged.coexistence_onboarded_at, now.toISOString());
  assert.strictEqual(merged.previous_coexistence_onboarded_at, '2026-01-01T00:00:00.000Z');
  assert.strictEqual(merged.coexistence_status, 'CONNECTED');
  assert.strictEqual(merged.is_on_biz_app, true);
  assert.strictEqual(merged.platform_type, 'CLOUD_API');
  assert.strictEqual(merged.credentials_rotated_at, now.toISOString());
  assert.strictEqual(merged.reconnect_count, 1);
  assert.deepStrictEqual(merged.coexistence_disconnection, { reason: 'USER_RE_REGISTERED' }, 'past disconnection kept');
  assert.ok(!JSON.stringify(merged).includes('access_token'));

  const brandNew = mergeReconnectSettings({ existing: {}, fresh, coexistence: false, now, credentialsRotated: false });
  assert.strictEqual(brandNew.coexistence_onboarded_at, undefined);
  assert.strictEqual(brandNew.reconnected_at, undefined);

  assert.deepStrictEqual(coexistenceVerificationWarnings({ isOnBizApp: true, platformType: 'CLOUD_API' }), []);
  assert.strictEqual(coexistenceVerificationWarnings({ isOnBizApp: false, platformType: 'ON_PREMISE' }).length, 2);

  const root = path.join(__dirname, '..');
  const signupRoute = fs.readFileSync(path.join(root, 'routes', 'whatsappEmbeddedSignupRoutes.ts'), 'utf8');
  assert.ok(!/body\??\.preferredPhone\b|preferredPhone\s*[:=]\s*req/.test(signupRoute), 'complete route no longer reads a client-supplied phone');
  assert.ok(!/\bpreferredPhone\b/.test(signupRoute), 'no legacy preferredPhone field');
  assert.ok(signupRoute.includes('preferredPhoneNumberId: target?.phoneNumberId'), 'reconnect uses the connection phone id');
  assert.ok(!signupRoute.includes('/register'), 'coexistence flow never calls register');
  assert.ok(signupRoute.includes("'RECONNECT_PHONE_MISMATCH'"), 'token swap re-checks phone id under row lock');
  const signupComplete = signupRoute.slice(0, signupRoute.indexOf("'/:id/whatsapp/sync-templates'"));
  assert.ok(
    signupComplete.indexOf('Meta farklı bir WhatsApp hesabı') < signupComplete.indexOf('subscribeAppToWaba({'),
    'mismatch rejected before any Meta write or DB write'
  );

  const outboundSvc = fs.readFileSync(path.join(root, 'services', 'outboundMessageService.ts'), 'utf8');
  const retryFn = outboundSvc.slice(outboundSvc.indexOf('export async function resetFailedForRetry'));
  assert.ok(retryFn.slice(0, 600).includes("idempotency_key NOT LIKE 'wa-coex:%'"), 'imported messages can never be re-sent');
  for (const file of ['routes/adminPlatformModules.ts', 'routes/platformAdminRoutes.ts']) {
    assert.ok(fs.readFileSync(path.join(root, file), 'utf8').includes("NOT LIKE 'wa-coex:%'"), `${file} excludes imports`);
  }
  const migrations = fs.readFileSync(path.join(root, 'database', 'runMigrations.ts'), 'utf8');
  assert.ok(migrations.includes("'whatsapp_coexistence_upgrade.sql'"));
  const sql = fs.readFileSync(path.join(root, 'database', 'whatsapp_coexistence_upgrade.sql'), 'utf8');
  assert.ok(!/DROP\s+(TABLE|COLUMN)|DELETE\s+FROM|TRUNCATE/i.test(sql), 'migration is additive');
  assert.ok((sql.match(/CREATE TABLE IF NOT EXISTS/g) || []).length === 2);
  assert.ok((sql.match(/ADD COLUMN IF NOT EXISTS/g) || []).length === 3);

  const frontendRoot = path.join(root, '..', '..', 'MailCenterFrontend', 'src');
  if (fs.existsSync(frontendRoot)) {
    const page = fs.readFileSync(path.join(frontendRoot, 'pages', 'ChannelWhatsAppSetup.tsx'), 'utf8');
    assert.ok(!/905323171755|532 317 17 55/.test(page), 'no hardcoded business number in setup page');
    assert.ok(page.includes('Yeniden bağla (Coexistence)'));
    assert.ok(page.includes('connectionId: reconnectConnectionId'));
  }
  console.log('  settings + regression guards ok');
}

async function main() {
  parserChecks();
  await routeChecks();
  await processorChecks();
  await syncChecks();
  settingsAndRegressionChecks();
  console.log('whatsappCoexistenceWebhookChecks PASS');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
