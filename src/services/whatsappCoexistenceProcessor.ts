/**
 * Persist + process WhatsApp Business app coexistence webhooks.
 *
 * Capture first (raw, deduplicated), process asynchronously. Imported history / echo
 * messages never enter the outbound queue and never reserve usage credits.
 */
import {
  CoexistenceLiveState,
  CoexistenceMessage,
  CoexistenceWebhookChange,
  COEXISTENCE_DISCONNECT_EVENTS,
  COEXISTENCE_RECONNECT_EVENTS,
  describeDisconnectReason,
  HISTORY_SHARING_DECLINED_CODE,
  mapHistoryStatusToOutbound,
  parseAccountUpdate,
  parseHistoryValue,
  parseMessageEchoes,
  parseStateSync,
  phoneDigits,
} from '../whatsapp/coexistenceWebhook';

export type Db = {
  query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

export type CoexistenceProcessorDeps = {
  db: Db;
  findConnectionsByPhoneNumberId: (phoneNumberId: string) => Promise<any[]>;
  findConnectionsByWabaId: (wabaId: string) => Promise<any[]>;
  ensureConversation: (params: {
    tenantId: number;
    brandId: number | null;
    channelConnectionId: number;
    phoneRaw: string;
    contactId: number | null;
    createStatus: 'OPEN' | 'RESOLVED';
  }) => Promise<{ id: number } | null>;
  touchConversationOutbound: (params: { conversationId: number; tenantId: number; at: Date }) => Promise<void>;
  resolveContactId: (tenantId: number, phoneRaw: string) => Promise<number | null>;
  getRemainingContactQuota: (tenantId: number) => Promise<number | null>;
  afterContactsCreated: (tenantId: number) => Promise<void>;
  notifyConversationUpdated: (tenantId: number, conversationId: number | null) => Promise<void>;
  /** Read-only Meta lookup with the connection's own token and phone number id. */
  verifyConnectionCoexistence: (connection: any) => Promise<CoexistenceLiveCheck>;
  now: () => Date;
};

export type CoexistenceLiveCheck = {
  state: CoexistenceLiveState;
  isOnBizApp: boolean | null;
  platformType: string | null;
};

export const IMPORTED_OUTBOUND_KEY_PREFIX = 'wa-coex:';

export type OutboundOrigin = 'BUSINESS_APP_ECHO' | 'HISTORY_SYNC';

export type StoredWebhookEvent = {
  id: number;
  field: string;
  event_name: string | null;
  waba_id: string | null;
  phone_number_id: string | null;
  payload: { entry_time?: number | null; value?: any } | any;
};

export type ProcessResult = { status: 'PROCESSED' | 'IGNORED'; summary: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Raw event store
// ---------------------------------------------------------------------------

export async function storeCoexistenceChanges(
  db: Db,
  changes: CoexistenceWebhookChange[],
  signatureSource: 'PLATFORM' | 'CONNECTION'
): Promise<{ stored: number; duplicates: number; ids: number[] }> {
  const ids: number[] = [];
  let duplicates = 0;
  for (const change of changes) {
    const result = await db.query(
      `INSERT INTO whatsapp_webhook_events
         (dedupe_key, field, event_name, waba_id, phone_number_id, payload, signature_source, status)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'PENDING')
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [
        change.dedupeKey,
        change.field,
        change.eventName,
        change.wabaId,
        change.phoneNumberId,
        JSON.stringify({ entry_time: change.entryTime, value: change.value }),
        signatureSource,
      ]
    );
    if (result.rows[0]?.id) ids.push(Number(result.rows[0].id));
    else duplicates += 1;
  }
  return { stored: ids.length, duplicates, ids };
}

export async function claimPendingCoexistenceEvents(
  db: Db,
  opts: { limit?: number; maxAttempts?: number } = {}
): Promise<StoredWebhookEvent[]> {
  const result = await db.query(
    `UPDATE whatsapp_webhook_events e
     SET status = 'PROCESSING',
         attempts = e.attempts + 1,
         locked_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE e.id IN (
       SELECT id FROM whatsapp_webhook_events
       WHERE status = 'PENDING'
          OR (status = 'FAILED' AND attempts < $2
              AND updated_at < CURRENT_TIMESTAMP - INTERVAL '2 minutes')
          OR (status = 'PROCESSING' AND locked_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes')
       ORDER BY id ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING e.id, e.field, e.event_name, e.waba_id, e.phone_number_id, e.payload`,
    [opts.limit ?? 20, opts.maxAttempts ?? 5]
  );
  return result.rows.sort((a, b) => Number(a.id) - Number(b.id));
}

async function markEventDone(db: Db, id: number, result: ProcessResult) {
  await db.query(
    `UPDATE whatsapp_webhook_events
     SET status = $2, result = $3::jsonb, last_error = NULL,
         processed_at = CURRENT_TIMESTAMP, locked_at = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [id, result.status, JSON.stringify(result.summary)]
  );
}

async function markEventFailed(db: Db, id: number, error: unknown) {
  const message = String((error as any)?.message || error || 'Processing failed')
    .replace(/EAA[A-Za-z0-9]+/g, '[redacted]')
    .slice(0, 500);
  await db.query(
    `UPDATE whatsapp_webhook_events
     SET status = 'FAILED', last_error = $2, locked_at = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [id, message]
  );
}

export async function drainCoexistenceEvents(
  deps: CoexistenceProcessorDeps,
  opts: { limit?: number; maxBatches?: number } = {}
): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;
  const maxBatches = opts.maxBatches ?? 10;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const events = await claimPendingCoexistenceEvents(deps.db, { limit: opts.limit });
    if (events.length === 0) break;
    for (const event of events) {
      try {
        const result = await processCoexistenceEvent(event, deps);
        await markEventDone(deps.db, Number(event.id), result);
        processed += 1;
      } catch (error) {
        await markEventFailed(deps.db, Number(event.id), error);
        failed += 1;
      }
    }
  }
  return { processed, failed };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function processCoexistenceEvent(
  event: StoredWebhookEvent,
  deps: CoexistenceProcessorDeps
): Promise<ProcessResult> {
  const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload || {};
  const value = payload.value || {};
  const entryTime = payload.entry_time ?? null;

  switch (event.field) {
    case 'account_update':
      return processAccountUpdate({ wabaId: event.waba_id, value, entryTime }, deps);
    case 'history':
      return processHistory({ phoneNumberId: event.phone_number_id, value }, deps);
    case 'smb_message_echoes':
      return processMessageEchoes({ phoneNumberId: event.phone_number_id, value }, deps);
    case 'smb_app_state_sync':
      return processStateSync({ phoneNumberId: event.phone_number_id, value }, deps);
    default:
      return { status: 'IGNORED', summary: { reason: 'unsupported_field' } };
  }
}

function connectionBusinessDigits(connection: any): string {
  const s = connection?.settings || {};
  return phoneDigits(s.business_phone_number || s.business_phone || s.display_phone_number);
}

function isCoexistenceConnection(connection: any): boolean {
  const s = connection?.settings || {};
  return (
    s.coexistence === true ||
    String(s.connection_type || '').toUpperCase() === 'WHATSAPP_BUSINESS_APP_ONBOARDING' ||
    s.is_on_biz_app === true
  );
}

// ---------------------------------------------------------------------------
// account_update
// ---------------------------------------------------------------------------

export async function processAccountUpdate(
  params: { wabaId: string | null; value: any; entryTime: number | null },
  deps: CoexistenceProcessorDeps
): Promise<ProcessResult> {
  const parsed = parseAccountUpdate({ value: params.value, entryTime: params.entryTime });
  const isDisconnect = parsed.event ? COEXISTENCE_DISCONNECT_EVENTS.has(parsed.event) : false;
  const isReconnect = parsed.event ? COEXISTENCE_RECONNECT_EVENTS.has(parsed.event) : false;
  if (!params.wabaId || (!isDisconnect && !isReconnect)) {
    return { status: 'IGNORED', summary: { event: parsed.event, reason: 'not_tracked' } };
  }

  const all = await deps.findConnectionsByWabaId(params.wabaId);
  // A phone number in the payload pins the event to that number. Without it (ACCOUNT_OFFBOARDED,
  // ACCOUNT_RECONNECTED) a WABA may hold several numbers, so each candidate is verified on its own.
  const pinnedByPhone = Boolean(parsed.phoneDigits);
  const targets = pinnedByPhone
    ? all.filter((c) => connectionBusinessDigits(c) === parsed.phoneDigits)
    : all.filter(isCoexistenceConnection);

  if (targets.length === 0) {
    return { status: 'IGNORED', summary: { event: parsed.event, reason: 'no_matching_connection' } };
  }

  const receivedAt = deps.now();
  const occurredAt = parsed.occurredAt || receivedAt;
  const statusAt = occurredAt.toISOString();
  const targetStatus = isDisconnect ? 'DISCONNECTED' : 'CONNECTED';
  const requiredLiveState: CoexistenceLiveState = isDisconnect ? 'NOT_ON_CLOUD_API' : 'COEXISTENCE_ACTIVE';

  const verification: Array<Record<string, unknown>> = [];
  const confirmed: Array<{ connection: any; live: CoexistenceLiveCheck | null }> = [];
  const unconfirmed: Array<{ id: unknown; state: string }> = [];
  for (const connection of targets) {
    if (pinnedByPhone) {
      confirmed.push({ connection, live: null });
      verification.push({ connectionId: connection.id, basis: 'PAYLOAD_PHONE_NUMBER' });
      continue;
    }
    const s = connection?.settings || {};
    if (s.coexistence_status === targetStatus && String(s.coexistence_status_at || '') >= statusAt) {
      verification.push({ connectionId: connection.id, basis: 'ALREADY_APPLIED' });
      continue;
    }
    let live: CoexistenceLiveCheck;
    try {
      live = await deps.verifyConnectionCoexistence(connection);
    } catch {
      live = { state: 'UNKNOWN', isOnBizApp: null, platformType: null };
    }
    verification.push({
      connectionId: connection.id,
      basis: 'META_LOOKUP',
      state: live.state,
      isOnBizApp: live.isOnBizApp,
      platformType: live.platformType,
    });
    if (live.state === requiredLiveState) confirmed.push({ connection, live });
    else unconfirmed.push({ id: connection.id, state: live.state });
  }

  let patch: Record<string, unknown>;
  if (isDisconnect) {
    patch = {
      coexistence_status: 'DISCONNECTED',
      coexistence_status_at: statusAt,
      coexistence_disconnection: {
        event: parsed.event,
        reason: parsed.reason,
        reason_label: describeDisconnectReason(parsed.reason),
        initiated_by: parsed.initiatedBy,
        phone_number: parsed.phoneDigits,
        occurred_at: statusAt,
        received_at: receivedAt.toISOString(),
      },
      last_error: `WhatsApp Business uygulaması bağlantısı koptu: ${describeDisconnectReason(parsed.reason)}`,
    };
  } else {
    patch = {
      coexistence_status: 'CONNECTED',
      coexistence_status_at: statusAt,
      coexistence_reconnected_at: statusAt,
    };
  }

  let updated = 0;
  for (const { connection, live } of confirmed) {
    const connectionPatch = live
      ? {
          ...patch,
          coexistence_verified_at: receivedAt.toISOString(),
          is_on_biz_app: live.isOnBizApp,
          platform_type: live.platformType,
        }
      : patch;
    // Out-of-order safe: ISO-8601 UTC strings compare chronologically.
    const res = await deps.db.query(
      `UPDATE channel_connections
       SET settings = COALESCE(settings, '{}'::jsonb) || $1::jsonb,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND tenant_id = $3
         AND COALESCE(settings->>'coexistence_status_at', '') <= $4`,
      [JSON.stringify(connectionPatch), connection.id, connection.tenant_id, statusAt]
    );
    updated += Number(res.rowCount || 0);
  }

  if (unconfirmed.length > 0) {
    // Status stays unchanged; the event is retried (bounded) and then left FAILED for review.
    throw new CoexistenceVerificationPendingError(
      `${parsed.event} doğrulanamadı; durum değiştirilmedi: ` +
        unconfirmed.map((u) => `bağlantı ${u.id}=${u.state}`).join(', ')
    );
  }

  return {
    status: 'PROCESSED',
    summary: {
      event: parsed.event,
      reason: parsed.reason,
      initiated_by: parsed.initiatedBy,
      connections: targets.map((c) => c.id),
      verification,
      updated,
    },
  };
}

export class CoexistenceVerificationPendingError extends Error {
  readonly code = 'COEXISTENCE_VERIFICATION_PENDING';
}

// ---------------------------------------------------------------------------
// Message import (history + echoes)
// ---------------------------------------------------------------------------

type ImportOutcome = 'inserted' | 'upgraded' | 'duplicate' | 'skipped_api_message';

export async function importInboundMessage(
  connection: any,
  msg: CoexistenceMessage,
  deps: CoexistenceProcessorDeps
): Promise<{ outcome: ImportOutcome; conversationId: number | null }> {
  const tenantId = connection.tenant_id;
  const at = msg.timestamp || deps.now();
  const contactId = await deps.resolveContactId(tenantId, msg.counterpartyDigits);
  const res = await deps.db.query(
    `INSERT INTO inbound_messages (
       tenant_id, brand_id, channel_connection_id, channel_type,
       sender_value, recipient_value, provider_message_id, message_type,
       content, media_metadata, received_at, contact_id, status, origin
     ) VALUES ($1,$2,$3,'WHATSAPP',$4,$5,$6,$7,$8,$9::jsonb,$10,$11,'PROCESSED','HISTORY_SYNC')
     ON CONFLICT (tenant_id, channel_type, provider_message_id) DO UPDATE
       SET message_type = EXCLUDED.message_type,
           content = EXCLUDED.content,
           media_metadata = EXCLUDED.media_metadata
       WHERE inbound_messages.message_type = 'media_placeholder'
         AND EXCLUDED.message_type <> 'media_placeholder'
     RETURNING id, conversation_id, (xmax = 0) AS inserted`,
    [
      tenantId,
      connection.brand_id ?? null,
      connection.id,
      msg.counterpartyDigits,
      connection.settings?.business_phone_number || null,
      msg.providerMessageId,
      msg.messageType,
      msg.textBody,
      JSON.stringify(msg.mediaMetadata || {}),
      at,
      contactId,
    ]
  );
  const row = res.rows[0];
  if (!row) return { outcome: 'duplicate', conversationId: null };
  if (!row.inserted) return { outcome: 'upgraded', conversationId: row.conversation_id ?? null };

  const conversation = await deps.ensureConversation({
    tenantId,
    brandId: connection.brand_id ?? null,
    channelConnectionId: connection.id,
    phoneRaw: msg.counterpartyDigits,
    contactId,
    createStatus: 'RESOLVED',
  });
  if (conversation) {
    await deps.db.query(
      `UPDATE inbound_messages SET conversation_id = $1
       WHERE id = $2 AND tenant_id = $3 AND conversation_id IS NULL`,
      [conversation.id, row.id, tenantId]
    );
    await touchConversationHistory(deps.db, {
      conversationId: conversation.id,
      tenantId,
      at,
      direction: 'INBOUND',
    });
  }
  return { outcome: 'inserted', conversationId: conversation?.id ?? null };
}

export async function importOutboundMessage(
  connection: any,
  msg: CoexistenceMessage,
  origin: OutboundOrigin,
  deps: CoexistenceProcessorDeps
): Promise<{ outcome: ImportOutcome; conversationId: number | null }> {
  const tenantId = connection.tenant_id;
  const at = msg.timestamp || deps.now();
  const status = origin === 'HISTORY_SYNC' ? mapHistoryStatusToOutbound(msg.historyStatus) : 'SENT';
  const idempotencyKey = `${IMPORTED_OUTBOUND_KEY_PREFIX}${msg.providerMessageId}`.slice(0, 191);
  const providerMetadata = {
    source: origin,
    message_type: msg.messageType,
    history_status: msg.historyStatus,
    media: msg.mediaMetadata,
  };

  // usage_reserved=false + status already final: never picked by the queue, never billed.
  const res = await deps.db.query(
    `INSERT INTO outbound_messages (
       tenant_id, brand_id, channel_type, recipient_data, message_content, plain_text_content,
       status, priority, idempotency_key, provider_message_id, attempt_count,
       queued_at, sent_at, failed_at, last_error_code, created_at, updated_at,
       usage_reserved, origin, provider_metadata
     )
     SELECT $1::int, $2::int, 'WHATSAPP', $3::jsonb, $4::text, $4::text,
            $5::text, 0, $6::text, $7::text, 0,
            $8::timestamp, $8::timestamp,
            CASE WHEN $5::text = 'FAILED' THEN $8::timestamp ELSE NULL END,
            CASE WHEN $5::text = 'FAILED' THEN 'HISTORY_ERROR' ELSE NULL END,
            $8::timestamp, CURRENT_TIMESTAMP,
            false, $9::text, $10::jsonb
     WHERE NOT EXISTS (
       SELECT 1 FROM outbound_messages
       WHERE tenant_id = $1::int AND provider_message_id = $7::text AND idempotency_key <> $6::text
     )
     ON CONFLICT (tenant_id, idempotency_key) DO UPDATE
       SET message_content = EXCLUDED.message_content,
           plain_text_content = EXCLUDED.plain_text_content,
           provider_metadata = EXCLUDED.provider_metadata,
           updated_at = CURRENT_TIMESTAMP
       WHERE outbound_messages.provider_metadata->>'message_type' = 'media_placeholder'
         AND EXCLUDED.provider_metadata->>'message_type' <> 'media_placeholder'
     RETURNING id, conversation_id, (xmax = 0) AS inserted`,
    [
      tenantId,
      connection.brand_id ?? null,
      JSON.stringify({ to: `+${msg.counterpartyDigits}` }),
      msg.textBody,
      status,
      idempotencyKey,
      msg.providerMessageId,
      at,
      origin,
      JSON.stringify(providerMetadata),
    ]
  );
  const row = res.rows[0];
  if (!row) {
    const apiDup = await deps.db.query(
      `SELECT 1 FROM outbound_messages
       WHERE tenant_id = $1 AND provider_message_id = $2 AND idempotency_key <> $3 LIMIT 1`,
      [tenantId, msg.providerMessageId, idempotencyKey]
    );
    return {
      outcome: apiDup.rows.length ? 'skipped_api_message' : 'duplicate',
      conversationId: null,
    };
  }
  if (!row.inserted) return { outcome: 'upgraded', conversationId: row.conversation_id ?? null };

  const contactId = await deps.resolveContactId(tenantId, msg.counterpartyDigits);
  const conversation = await deps.ensureConversation({
    tenantId,
    brandId: connection.brand_id ?? null,
    channelConnectionId: connection.id,
    phoneRaw: msg.counterpartyDigits,
    contactId,
    createStatus: origin === 'HISTORY_SYNC' ? 'RESOLVED' : 'OPEN',
  });
  if (conversation) {
    await deps.db.query(
      `UPDATE outbound_messages SET conversation_id = $1 WHERE id = $2 AND tenant_id = $3`,
      [conversation.id, row.id, tenantId]
    );
    if (origin === 'BUSINESS_APP_ECHO') {
      await deps.touchConversationOutbound({ conversationId: conversation.id, tenantId, at });
    } else {
      await touchConversationHistory(deps.db, {
        conversationId: conversation.id,
        tenantId,
        at,
        direction: 'OUTBOUND',
      });
    }
  }
  return { outcome: 'inserted', conversationId: conversation?.id ?? null };
}

/** Timestamps only — history never reopens conversations or adds unread counts. */
async function touchConversationHistory(
  db: Db,
  params: { conversationId: number; tenantId: number; at: Date; direction: 'INBOUND' | 'OUTBOUND' }
) {
  const column = params.direction === 'INBOUND' ? 'last_inbound_at' : 'last_outbound_at';
  await db.query(
    `UPDATE conversations
     SET last_message_at = GREATEST(COALESCE(last_message_at, $3), $3),
         ${column} = GREATEST(COALESCE(${column}, $3), $3),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND tenant_id = $2`,
    [params.conversationId, params.tenantId, params.at]
  );
}

function emptyCounts() {
  return { inserted: 0, upgraded: 0, duplicate: 0, skipped_api_message: 0 };
}

async function importMessages(
  connection: any,
  messages: CoexistenceMessage[],
  origin: OutboundOrigin,
  deps: CoexistenceProcessorDeps
) {
  const counts = { inbound: emptyCounts(), outbound: emptyCounts() };
  const conversations = new Set<number>();
  for (const msg of messages) {
    const result =
      msg.direction === 'OUTBOUND'
        ? await importOutboundMessage(connection, msg, origin, deps)
        : origin === 'HISTORY_SYNC'
          ? await importInboundMessage(connection, msg, deps)
          : { outcome: 'duplicate' as ImportOutcome, conversationId: null };
    const bucket = msg.direction === 'OUTBOUND' ? counts.outbound : counts.inbound;
    bucket[result.outcome] += 1;
    if (result.conversationId) conversations.add(result.conversationId);
  }
  return { counts, conversations };
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

async function updateSyncProgress(
  db: Db,
  params: {
    connectionId: number;
    syncType: 'CONTACTS' | 'HISTORY';
    progress?: number | null;
    phase?: number | null;
    chunks?: number;
    received?: number;
    imported?: number;
    skipped?: number;
    declined?: boolean;
  }
) {
  const progress = params.progress ?? null;
  await db.query(
    `UPDATE whatsapp_coexistence_sync_requests
     SET status = CASE
           WHEN $9::boolean THEN 'DECLINED'
           WHEN status IN ('COMPLETED', 'DECLINED') THEN status
           WHEN $3::int IS NOT NULL AND $3::int >= 100 THEN 'COMPLETED'
           ELSE 'IN_PROGRESS'
         END,
         progress = CASE WHEN $3::int IS NULL THEN progress ELSE GREATEST(COALESCE(progress, 0), $3::int) END,
         last_phase = CASE WHEN $4::int IS NULL THEN last_phase ELSE GREATEST(COALESCE(last_phase, -1), $4::int) END,
         chunks_received = chunks_received + $5,
         items_received = items_received + $6,
         items_imported = items_imported + $7,
         items_skipped = items_skipped + $8,
         last_error_code = CASE WHEN $9::boolean THEN '${HISTORY_SHARING_DECLINED_CODE}' ELSE last_error_code END,
         last_error_message = CASE WHEN $9::boolean
           THEN 'İşletme WhatsApp Business uygulamasında geçmiş paylaşımını kapattı'
           ELSE last_error_message END,
         accepted_at = COALESCE(accepted_at, CURRENT_TIMESTAMP),
         completed_at = CASE
           WHEN completed_at IS NULL AND ($9::boolean OR ($3::int IS NOT NULL AND $3::int >= 100))
             THEN CURRENT_TIMESTAMP
           ELSE completed_at END,
         last_event_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = (
       SELECT id FROM whatsapp_coexistence_sync_requests
       WHERE channel_connection_id = $1 AND sync_type = $2
         AND status IN ('REQUESTED', 'UNCERTAIN', 'IN_PROGRESS', 'COMPLETED')
       ORDER BY requested_at DESC, id DESC
       LIMIT 1
     )`,
    [
      params.connectionId,
      params.syncType,
      progress,
      params.phase ?? null,
      params.chunks ?? 0,
      params.received ?? 0,
      params.imported ?? 0,
      params.skipped ?? 0,
      Boolean(params.declined),
    ]
  );
}

export async function processHistory(
  params: { phoneNumberId: string | null; value: any },
  deps: CoexistenceProcessorDeps
): Promise<ProcessResult> {
  if (!params.phoneNumberId) {
    return { status: 'IGNORED', summary: { reason: 'missing_phone_number_id' } };
  }
  const connections = await deps.findConnectionsByPhoneNumberId(params.phoneNumberId);
  if (connections.length === 0) {
    return { status: 'IGNORED', summary: { reason: 'unknown_phone_number_id' } };
  }

  const parsed = parseHistoryValue(params.value);
  // Chunks may arrive out of order; import order inside a delivery follows chunk_order.
  const chunks = [...parsed.chunks].sort(
    (a, b) => (a.phase ?? 0) - (b.phase ?? 0) || (a.chunkOrder ?? 0) - (b.chunkOrder ?? 0)
  );

  const perConnection: Record<string, unknown>[] = [];
  for (const connection of connections) {
    let declined = false;
    let imported = 0;
    let received = 0;
    const touched = new Set<number>();

    for (const chunk of chunks) {
      if (chunk.declined) {
        declined = true;
        await updateSyncProgress(deps.db, {
          connectionId: connection.id,
          syncType: 'HISTORY',
          declined: true,
        });
        continue;
      }
      const result = await importMessages(connection, chunk.messages, 'HISTORY_SYNC', deps);
      const chunkImported =
        result.counts.inbound.inserted + result.counts.outbound.inserted;
      imported += chunkImported;
      received += chunk.messages.length;
      result.conversations.forEach((id) => touched.add(id));
      await updateSyncProgress(deps.db, {
        connectionId: connection.id,
        syncType: 'HISTORY',
        progress: chunk.progress,
        phase: chunk.phase,
        chunks: 1,
        received: chunk.messages.length,
        imported: chunkImported,
        skipped: chunk.messages.length - chunkImported,
      });
    }

    if (parsed.mediaMessages.length > 0) {
      const media = await importMessages(connection, parsed.mediaMessages, 'HISTORY_SYNC', deps);
      media.conversations.forEach((id) => touched.add(id));
      received += parsed.mediaMessages.length;
      imported += media.counts.inbound.inserted + media.counts.outbound.inserted;
    }

    for (const conversationId of touched) {
      await deps.notifyConversationUpdated(connection.tenant_id, conversationId);
    }
    perConnection.push({ connection_id: connection.id, declined, received, imported });
  }

  return {
    status: 'PROCESSED',
    summary: {
      chunks: chunks.map((c) => ({ phase: c.phase, chunk_order: c.chunkOrder, progress: c.progress })),
      media_messages: parsed.mediaMessages.length,
      connections: perConnection,
    },
  };
}

// ---------------------------------------------------------------------------
// smb_message_echoes
// ---------------------------------------------------------------------------

export async function processMessageEchoes(
  params: { phoneNumberId: string | null; value: any },
  deps: CoexistenceProcessorDeps
): Promise<ProcessResult> {
  if (!params.phoneNumberId) {
    return { status: 'IGNORED', summary: { reason: 'missing_phone_number_id' } };
  }
  const connections = await deps.findConnectionsByPhoneNumberId(params.phoneNumberId);
  if (connections.length === 0) {
    return { status: 'IGNORED', summary: { reason: 'unknown_phone_number_id' } };
  }
  const echoes = parseMessageEchoes(params.value);
  const perConnection: Record<string, unknown>[] = [];
  for (const connection of connections) {
    const result = await importMessages(connection, echoes, 'BUSINESS_APP_ECHO', deps);
    for (const conversationId of result.conversations) {
      await deps.notifyConversationUpdated(connection.tenant_id, conversationId);
    }
    perConnection.push({ connection_id: connection.id, ...result.counts.outbound });
  }
  return { status: 'PROCESSED', summary: { echoes: echoes.length, connections: perConnection } };
}

// ---------------------------------------------------------------------------
// smb_app_state_sync (contacts)
// ---------------------------------------------------------------------------

export async function processStateSync(
  params: { phoneNumberId: string | null; value: any },
  deps: CoexistenceProcessorDeps
): Promise<ProcessResult> {
  if (!params.phoneNumberId) {
    return { status: 'IGNORED', summary: { reason: 'missing_phone_number_id' } };
  }
  const connections = await deps.findConnectionsByPhoneNumberId(params.phoneNumberId);
  if (connections.length === 0) {
    return { status: 'IGNORED', summary: { reason: 'unknown_phone_number_id' } };
  }
  const contacts = parseStateSync(params.value);
  const perConnection: Record<string, unknown>[] = [];

  for (const connection of connections) {
    const tenantId = connection.tenant_id;
    const counts = { created: 0, enriched: 0, existing: 0, removed_ignored: 0, skipped_quota: 0 };
    let remaining = await deps.getRemainingContactQuota(tenantId);

    for (const contact of contacts) {
      if (contact.action === 'remove') {
        // CRM data is owned by the tenant; a removal in the phone address book never deletes it.
        counts.removed_ignored += 1;
        continue;
      }
      const e164 = `+${contact.phoneDigits}`;
      const existingId = await deps.resolveContactId(tenantId, e164);
      if (existingId) {
        const res = await deps.db.query(
          `UPDATE contacts
           SET first_name = COALESCE(NULLIF(BTRIM(first_name), ''), $3),
               last_name = COALESCE(NULLIF(BTRIM(last_name), ''), $4),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND tenant_id = $2
             AND ((NULLIF(BTRIM(first_name), '') IS NULL AND $3::text IS NOT NULL)
               OR (NULLIF(BTRIM(last_name), '') IS NULL AND $4::text IS NOT NULL))`,
          [existingId, tenantId, contact.firstName, contact.lastName]
        );
        if (Number(res.rowCount || 0) > 0) counts.enriched += 1;
        else counts.existing += 1;
        continue;
      }
      if (remaining !== null && remaining <= 0) {
        counts.skipped_quota += 1;
        continue;
      }
      const inserted = await deps.db.query(
        `INSERT INTO contacts (tenant_id, first_name, last_name, notes, status)
         VALUES ($1, $2, $3, $4, 'ACTIVE')
         RETURNING id`,
        [tenantId, contact.firstName, contact.lastName, 'WhatsApp Business uygulamasından eşitlendi']
      );
      const contactId = Number(inserted.rows[0].id);
      const point = await deps.db.query(
        `INSERT INTO contact_points
           (tenant_id, contact_id, channel_type, value, normalized_value, is_primary, is_active)
         VALUES ($1, $2, 'WHATSAPP', $3, $3, true, true)
         ON CONFLICT (tenant_id, channel_type, normalized_value) DO NOTHING
         RETURNING id`,
        [tenantId, contactId, e164]
      );
      if (!point.rows[0]) {
        await deps.db.query(`DELETE FROM contacts WHERE id = $1 AND tenant_id = $2`, [contactId, tenantId]);
        counts.existing += 1;
        continue;
      }
      if (connection.brand_id) {
        await deps.db.query(
          `INSERT INTO contact_brand_links (tenant_id, contact_id, brand_id)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [tenantId, contactId, connection.brand_id]
        );
      }
      counts.created += 1;
      if (remaining !== null) remaining -= 1;
    }

    if (counts.created > 0) await deps.afterContactsCreated(tenantId);
    await updateSyncProgress(deps.db, {
      connectionId: connection.id,
      syncType: 'CONTACTS',
      chunks: 1,
      received: contacts.length,
      imported: counts.created + counts.enriched,
      skipped: counts.skipped_quota,
    });
    perConnection.push({ connection_id: connection.id, ...counts });
  }

  return { status: 'PROCESSED', summary: { contacts: contacts.length, connections: perConnection } };
}

export function isImportedOutboundKey(idempotencyKey: unknown): boolean {
  return String(idempotencyKey || '').startsWith(IMPORTED_OUTBOUND_KEY_PREFIX);
}
