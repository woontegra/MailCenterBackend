/**
 * SMB app data sync triggers (contacts / history) for coexistence connections.
 * Meta: each sync_type may be requested once per onboarding, within 24h of onboarding.
 */
import type { Db } from './whatsappCoexistenceProcessor';
import type { SmbAppDataSyncResult, SmbAppDataSyncType } from './metaEmbeddedSignupService';

export const COEXISTENCE_SYNC_WINDOW_MS = 24 * 60 * 60 * 1000;

export type CoexistenceSyncType = 'CONTACTS' | 'HISTORY';

export function parseCoexistenceSyncType(raw: unknown): CoexistenceSyncType | null {
  const v = String(raw || '').trim().toUpperCase();
  if (v === 'CONTACTS' || v === 'SMB_APP_STATE_SYNC') return 'CONTACTS';
  if (v === 'HISTORY') return 'HISTORY';
  return null;
}

export function metaSyncTypeFor(type: CoexistenceSyncType): SmbAppDataSyncType {
  return type === 'CONTACTS' ? 'smb_app_state_sync' : 'history';
}

export type SyncEligible = { ok: true; onboardingKey: string; onboardedAt: Date; deadline: Date };
export type SyncIneligible = {
  ok: false;
  code: string;
  message: string;
  onboardedAt?: Date | null;
  deadline?: Date | null;
};
export type SyncEligibility = SyncEligible | SyncIneligible;

export function evaluateCoexistenceSyncEligibility(connection: any, now: Date): SyncEligibility {
  const s = connection?.settings && typeof connection.settings === 'object' ? connection.settings : {};
  if (String(connection?.channel_type || '').toUpperCase() !== 'WHATSAPP') {
    return { ok: false, code: 'NOT_WHATSAPP', message: 'Bu bağlantı WhatsApp bağlantısı değil' };
  }
  if (!['META_WHATSAPP_CLOUD', 'META_CLOUD'].includes(String(connection?.provider || '').toUpperCase())) {
    return { ok: false, code: 'NOT_META', message: 'Bu bağlantı Meta Cloud API bağlantısı değil' };
  }
  const isCoexistence =
    s.coexistence === true &&
    String(s.connection_type || '').toUpperCase() === 'WHATSAPP_BUSINESS_APP_ONBOARDING';
  if (!isCoexistence) {
    return {
      ok: false,
      code: 'NOT_COEXISTENCE',
      message: 'Eşitleme yalnızca "Yeniden bağla (Coexistence)" ile bağlanan hatlarda yapılabilir',
    };
  }
  const onboardedRaw = String(s.coexistence_onboarded_at || '').trim();
  const onboardedAt = onboardedRaw ? new Date(onboardedRaw) : null;
  if (!onboardedAt || Number.isNaN(onboardedAt.getTime())) {
    return {
      ok: false,
      code: 'NO_ONBOARDING_TIME',
      message: 'Coexistence bağlantı zamanı bulunamadı; önce yeniden bağlayın',
    };
  }
  const deadline = new Date(onboardedAt.getTime() + COEXISTENCE_SYNC_WINDOW_MS);
  if (String(connection?.status || '').toUpperCase() !== 'ACTIVE' || !connection?.encrypted_credentials) {
    return { ok: false, code: 'NOT_ACTIVE', message: 'Bağlantı aktif değil', onboardedAt, deadline };
  }
  const statusAt = String(s.coexistence_status_at || '');
  if (s.coexistence_status === 'DISCONNECTED' && statusAt >= onboardedAt.toISOString()) {
    return {
      ok: false,
      code: 'DISCONNECTED',
      message: 'Meta bağlantının koptuğunu bildirdi; önce yeniden bağlayın',
      onboardedAt,
      deadline,
    };
  }
  if (now.getTime() > deadline.getTime()) {
    return {
      ok: false,
      code: 'WINDOW_EXPIRED',
      message:
        'Meta eşitleme süresi (bağlantıdan sonraki 24 saat) doldu. Yeniden eşitleme için işletmenin bağlantıyı kesip akışı baştan yapması gerekir.',
      onboardedAt,
      deadline,
    };
  }
  return { ok: true, onboardingKey: onboardedAt.toISOString(), onboardedAt, deadline };
}

export type CoexistenceSyncDeps = {
  db: Db;
  unpackAccessToken: (encrypted: string | null) => string;
  callSmbAppData: (params: {
    accessToken: string;
    phoneNumberId: string;
    syncType: SmbAppDataSyncType;
    apiVersion?: string;
  }) => Promise<SmbAppDataSyncResult>;
  now: () => Date;
};

export class CoexistenceSyncError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    message: string,
    public readonly data?: unknown
  ) {
    super(message);
  }
}

export function publicSyncRow(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    syncType: row.sync_type,
    status: row.status,
    requestId: row.request_id || null,
    attempts: row.attempts,
    progress: row.progress,
    lastPhase: row.last_phase,
    chunksReceived: row.chunks_received,
    itemsReceived: row.items_received,
    itemsImported: row.items_imported,
    itemsSkipped: row.items_skipped,
    lastErrorCode: row.last_error_code || null,
    lastErrorMessage: row.last_error_message || null,
    requestedAt: row.requested_at,
    acceptedAt: row.accepted_at,
    lastEventAt: row.last_event_at,
    completedAt: row.completed_at,
    onboardingKey: row.onboarding_key,
  };
}

async function loadConnection(db: Db, tenantId: number, connectionId: number) {
  const res = await db.query(
    `SELECT id, tenant_id, brand_id, channel_type, provider, status, settings, encrypted_credentials
     FROM channel_connections WHERE id = $1 AND tenant_id = $2`,
    [connectionId, tenantId]
  );
  return res.rows[0] || null;
}

export async function requestCoexistenceSync(
  params: {
    tenantId: number;
    connectionId: number;
    syncType: CoexistenceSyncType;
    userId: number | null;
    confirmRetry?: boolean;
  },
  deps: CoexistenceSyncDeps
) {
  const connection = await loadConnection(deps.db, params.tenantId, params.connectionId);
  if (!connection) throw new CoexistenceSyncError(404, 'NOT_FOUND', 'Bağlantı bulunamadı');

  const eligibility = evaluateCoexistenceSyncEligibility(connection, deps.now());
  if (!eligibility.ok) {
    const bad = eligibility as SyncIneligible;
    throw new CoexistenceSyncError(422, bad.code, bad.message);
  }
  const phoneNumberId = String(connection.settings?.phone_number_id || '').trim();
  if (!phoneNumberId) {
    throw new CoexistenceSyncError(422, 'NO_PHONE_NUMBER_ID', 'Phone Number ID eksik');
  }

  // Atomic once-only claim. Retry only after a definitive Meta rejection (FAILED) or,
  // with explicit confirmation, after an unknown outcome (UNCERTAIN).
  const claim = await deps.db.query(
    `INSERT INTO whatsapp_coexistence_sync_requests
       (tenant_id, channel_connection_id, phone_number_id, onboarding_key, sync_type,
        status, requested_by, requested_at)
     VALUES ($1, $2, $3, $4, $5, 'REQUESTING', $6, CURRENT_TIMESTAMP)
     ON CONFLICT (channel_connection_id, onboarding_key, sync_type) DO UPDATE
       SET status = 'REQUESTING',
           attempts = whatsapp_coexistence_sync_requests.attempts + 1,
           requested_by = EXCLUDED.requested_by,
           requested_at = CURRENT_TIMESTAMP,
           last_error_code = NULL,
           last_error_message = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE whatsapp_coexistence_sync_requests.request_id IS NULL
         AND (
           whatsapp_coexistence_sync_requests.status = 'FAILED'
           OR (whatsapp_coexistence_sync_requests.status = 'UNCERTAIN' AND $7::boolean)
         )
     RETURNING *`,
    [
      params.tenantId,
      connection.id,
      phoneNumberId,
      eligibility.onboardingKey,
      params.syncType,
      params.userId,
      Boolean(params.confirmRetry),
    ]
  );

  if (!claim.rows[0]) {
    const existing = await deps.db.query(
      `SELECT * FROM whatsapp_coexistence_sync_requests
       WHERE channel_connection_id = $1 AND onboarding_key = $2 AND sync_type = $3`,
      [connection.id, eligibility.onboardingKey, params.syncType]
    );
    const row = existing.rows[0];
    const uncertain = row?.status === 'UNCERTAIN';
    throw new CoexistenceSyncError(
      409,
      uncertain ? 'SYNC_UNCERTAIN' : 'SYNC_ALREADY_REQUESTED',
      uncertain
        ? 'Önceki istekte Meta yanıtı alınamadı; Meta isteği kabul etmiş olabilir. Webhook gelmezse onaylayarak yeniden deneyin.'
        : 'Bu eşitleme bu bağlantı için zaten istendi. Meta her eşitlemeye yalnızca bir kez izin verir.',
      publicSyncRow(row)
    );
  }

  const claimed = claim.rows[0];
  let accessToken: string;
  try {
    accessToken = deps.unpackAccessToken(connection.encrypted_credentials);
  } catch {
    await deps.db.query(
      `UPDATE whatsapp_coexistence_sync_requests
       SET status = 'FAILED', last_error_code = 'MISSING_CREDENTIALS',
           last_error_message = 'Bağlantı kimlik bilgileri okunamadı', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [claimed.id]
    );
    throw new CoexistenceSyncError(422, 'MISSING_CREDENTIALS', 'Bağlantı kimlik bilgileri okunamadı');
  }

  const result = await deps.callSmbAppData({
    accessToken,
    phoneNumberId,
    syncType: metaSyncTypeFor(params.syncType),
    apiVersion: connection.settings?.api_version || undefined,
  });

  if (result.ok) {
    const updated = await deps.db.query(
      `UPDATE whatsapp_coexistence_sync_requests
       SET status = CASE WHEN status = 'REQUESTING' THEN 'REQUESTED' ELSE status END,
           request_id = $2,
           accepted_at = COALESCE(accepted_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [claimed.id, result.requestId]
    );
    return { sync: publicSyncRow(updated.rows[0]), deadline: eligibility.deadline };
  }

  const failure = result as Extract<SmbAppDataSyncResult, { ok: false }>;
  const updated = await deps.db.query(
    `UPDATE whatsapp_coexistence_sync_requests
     SET status = $2, last_error_code = $3, last_error_message = $4, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status = 'REQUESTING'
     RETURNING *`,
    [
      claimed.id,
      failure.uncertain ? 'UNCERTAIN' : 'FAILED',
      failure.metaCode || (failure.uncertain ? 'META_UNREACHABLE' : `HTTP_${failure.status}`),
      failure.message.slice(0, 500),
    ]
  );
  throw new CoexistenceSyncError(
    failure.uncertain ? 504 : 502,
    failure.uncertain ? 'SYNC_UNCERTAIN' : 'META_REJECTED',
    failure.uncertain
      ? 'Meta yanıtı alınamadı. İstek kabul edilmiş olabilir; webhook olaylarını bekleyin.'
      : `Meta eşitleme isteğini reddetti: ${failure.message}`,
    publicSyncRow(updated.rows[0])
  );
}

export async function getCoexistenceStatus(
  params: { tenantId: number; connectionId: number },
  deps: Pick<CoexistenceSyncDeps, 'db' | 'now'>
) {
  const connection = await loadConnection(deps.db, params.tenantId, params.connectionId);
  if (!connection) throw new CoexistenceSyncError(404, 'NOT_FOUND', 'Bağlantı bulunamadı');
  const s = connection.settings || {};
  const now = deps.now();
  const eligibility = evaluateCoexistenceSyncEligibility(connection, now);
  const onboardingKey = eligibility.ok
    ? eligibility.onboardingKey
    : eligibility.onboardedAt
      ? eligibility.onboardedAt.toISOString()
      : null;

  let syncs: any[] = [];
  try {
    const res = await deps.db.query(
      `SELECT * FROM whatsapp_coexistence_sync_requests
       WHERE tenant_id = $1 AND channel_connection_id = $2
       ORDER BY requested_at DESC, id DESC
       LIMIT 20`,
      [params.tenantId, connection.id]
    );
    syncs = res.rows;
  } catch (error: any) {
    if (error?.code !== '42P01') throw error;
  }
  const current = (type: CoexistenceSyncType) =>
    publicSyncRow(syncs.find((r) => r.sync_type === type && r.onboarding_key === onboardingKey));

  return {
    connectionId: connection.id,
    coexistence: s.coexistence === true,
    connectionType: s.connection_type || s.connection_method || null,
    status: s.coexistence_status || null,
    statusAt: s.coexistence_status_at || null,
    onboardedAt: s.coexistence_onboarded_at || null,
    syncDeadline: eligibility.ok
      ? eligibility.deadline.toISOString()
      : eligibility.deadline
        ? eligibility.deadline.toISOString()
        : null,
    isOnBizApp: typeof s.is_on_biz_app === 'boolean' ? s.is_on_biz_app : null,
    platformType: s.platform_type || null,
    disconnection: s.coexistence_disconnection || null,
    eligibility: eligibility.ok
      ? { ok: true }
      : {
          ok: false,
          code: (eligibility as SyncIneligible).code,
          message: (eligibility as SyncIneligible).message,
        },
    syncs: { contacts: current('CONTACTS'), history: current('HISTORY') },
    history: syncs.map(publicSyncRow),
    serverTime: now.toISOString(),
  };
}
