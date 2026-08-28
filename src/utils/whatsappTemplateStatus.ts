/**
 * WhatsApp template approval vs quality score helpers.
 * Meta template `status` drives approval; `quality_score` is informational only.
 */

export type MetaQualityScore = {
  score?: string | null;
  status?: string | null;
  date?: number | null;
} | null;

export function parseTemplateComponents(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function extractQualityScore(components: unknown): MetaQualityScore {
  const obj = parseTemplateComponents(components);
  const qs = obj.quality_score;
  if (!qs || typeof qs !== 'object') return null;
  return qs as MetaQualityScore;
}

/** Quality rating not yet assigned — does not block sending. */
export function isQualityScorePending(approval: string, quality: MetaQualityScore): boolean {
  if (String(approval).toUpperCase() !== 'APPROVED') return false;
  if (!quality) return true;
  const score = String(quality.score || '').toUpperCase();
  const status = String(quality.status || '').toUpperCase();
  if (status === 'PENDING') return true;
  if (!score || score === 'UNKNOWN') return true;
  return false;
}

export function mapMetaStatusToApproval(status: string): string {
  const s = String(status || '').toUpperCase();
  if (s === 'APPROVED') return 'APPROVED';
  if (s === 'REJECTED' || s === 'DISABLED') return 'REJECTED';
  if (s === 'PAUSED') return 'PAUSED';
  if (s === 'PENDING' || s === 'IN_APPEAL') return 'PENDING';
  return 'UNKNOWN';
}

export function buildProviderComponentsPayload(params: {
  metaTemplateId: string;
  category: string | null;
  status: string;
  components: unknown;
  wabaId: string;
  rejectedReason: string | null;
  qualityScore: MetaQualityScore;
  lastSyncedAt: string;
}): Record<string, unknown> {
  return {
    meta_template_id: params.metaTemplateId,
    category: params.category,
    status: String(params.status || '').toUpperCase(),
    components: params.components,
    waba_id: params.wabaId,
    rejected_reason: params.rejectedReason || null,
    quality_score: params.qualityScore || null,
    last_synced_at: params.lastSyncedAt,
  };
}

export function whatsappTemplateCanSend(row: {
  provider_approval_status?: string | null;
  provider_template_name?: string | null;
  is_active?: boolean | null;
  is_draft?: boolean | null;
}): boolean {
  if (row.is_draft === true) return false;
  if (row.is_active === false) return false;
  if (String(row.provider_approval_status || '').toUpperCase() !== 'APPROVED') return false;
  return Boolean(String(row.provider_template_name || '').trim());
}

export function whatsappTemplateDisplay(params: {
  provider_approval_status?: string | null;
  provider_template_components?: unknown;
  provider_rejection_reason?: string | null;
}): { label: string; help: string; canSend: boolean; qualityPending: boolean } {
  const approval = String(params.provider_approval_status || 'UNKNOWN').toUpperCase();
  const quality = extractQualityScore(params.provider_template_components);
  const qualityPending = isQualityScorePending(approval, quality);
  const canSend = approval === 'APPROVED';

  if (approval === 'APPROVED') {
    return {
      label: 'Onaylandı · Gönderilebilir',
      help: qualityPending ? 'Kalite puanı henüz oluşmadı.' : 'Gönderilebilir.',
      canSend,
      qualityPending,
    };
  }
  if (approval === 'PENDING') {
    return {
      label: 'Meta onayı bekleniyor',
      help: 'Onaylanana kadar gönderilemez.',
      canSend: false,
      qualityPending: false,
    };
  }
  if (approval === 'REJECTED') {
    const reason = String(params.provider_rejection_reason || '').trim();
    return {
      label: 'Reddedildi',
      help: reason || 'Meta tarafından reddedildi. Nedeni görüntüleyip düzenleyebilirsiniz.',
      canSend: false,
      qualityPending: false,
    };
  }
  if (approval === 'PAUSED') {
    return {
      label: 'Geçici olarak durduruldu',
      help: 'Geçici olarak durduruldu.',
      canSend: false,
      qualityPending: false,
    };
  }
  return {
    label: 'Durum güncelleniyor',
    help: 'Durum henüz Meta\'dan alınamadı. Durumu yenileyin.',
    canSend: false,
    qualityPending: false,
  };
}
