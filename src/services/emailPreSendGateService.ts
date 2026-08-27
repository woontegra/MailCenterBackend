import { query } from '../config/database';
import { normalizeEmail } from '../utils/contactNormalize';
import {
  checkRecipientEligibility,
  type EligibilityResult,
} from '../utils/recipientEligibility';
import {
  findSuppressedEmails,
  normalizeEmailAddress,
  type SuppressionReason,
} from './suppressionService';

export type EmailSendPolicy = 'transactional' | 'marketing' | 'standard';

export type PreSendGateBlockCode =
  | 'UNSUBSCRIBED'
  | 'BOUNCE_PERMANENT'
  | 'SPAM_COMPLAINT'
  | 'SUPPRESSION_BLOCKED'
  | 'NO_PERMISSION'
  | 'CAMPAIGN_STOPPED'
  | 'RECIPIENT_ALREADY_HANDLED'
  | 'CONTACT_BLOCKED';

export type PreSendGateResult =
  | { allowed: true }
  | {
      allowed: false;
      code: PreSendGateBlockCode;
      userMessage: string;
      outboundStatus: 'CANCELLED';
      recipientStatus: 'SKIPPED' | 'CANCELLED';
    };

export type OutboundEmailGateContext = {
  tenantId: number;
  brandId?: number | null;
  campaignId?: number | null;
  campaignRecipientId?: number | null;
  conversationId?: number | null;
  idempotencyKey?: string | null;
  recipientData?: Record<string, unknown> | null;
  toAddresses: string[];
};

const TERMINAL_RECIPIENT_STATUSES = new Set(['SENT', 'SKIPPED', 'CANCELLED']);

/** System / mandatory mail — not subject to marketing suppression rules. */
export function resolveEmailSendPolicy(ctx: {
  campaignId?: number | null;
  campaignRecipientId?: number | null;
  conversationId?: number | null;
  idempotencyKey?: string | null;
  recipientData?: Record<string, unknown> | null;
}): EmailSendPolicy {
  const key = String(ctx.idempotencyKey || '').trim();
  if (key.startsWith('team_invite_')) {
    return 'transactional';
  }

  if (ctx.campaignId || ctx.campaignRecipientId) {
    return 'marketing';
  }

  return 'standard';
}

export function userMessageForSuppression(reason: string): string {
  switch (String(reason || '').toUpperCase()) {
    case 'UNSUBSCRIBED':
      return 'Abonelikten çıktı';
    case 'BOUNCE_PERMANENT':
      return 'Kalıcı teslim hatası nedeniyle engellendi';
    case 'SPAM_COMPLAINT':
      return 'Şikâyet nedeniyle engellendi';
    case 'ADMIN_BLOCKED':
    case 'INVALID_ADDRESS':
      return 'Şikâyet nedeniyle engellendi';
    default:
      return 'Şikâyet nedeniyle engellendi';
  }
}

function blockFromEligibility(result: EligibilityResult): PreSendGateResult | null {
  if (result.eligible) return null;

  const code = String(result.code || '').toUpperCase();
  if (code === 'BLOCKED' || code === 'CONTACT_BLOCKED') {
    return {
      allowed: false,
      code: 'CONTACT_BLOCKED',
      userMessage: 'İletişim izni bulunmuyor',
      outboundStatus: 'CANCELLED',
      recipientStatus: 'SKIPPED',
    };
  }

  if (code === 'OPTED_OUT' || code === 'UNKNOWN_PREFERENCE' || code === 'NOT_OPTED_IN') {
    return {
      allowed: false,
      code: 'NO_PERMISSION',
      userMessage: 'İletişim izni bulunmuyor',
      outboundStatus: 'CANCELLED',
      recipientStatus: 'SKIPPED',
    };
  }

  return null;
}

async function checkMarketingCampaignState(params: {
  tenantId: number;
  campaignId: number;
  campaignRecipientId: number;
}): Promise<PreSendGateResult | null> {
  const row = await query(
    `SELECT cr.status AS recipient_status,
            c.status AS campaign_status
     FROM campaign_recipients cr
     JOIN campaigns c ON c.id = cr.campaign_id AND c.tenant_id = cr.tenant_id
     WHERE cr.id = $1 AND cr.tenant_id = $2 AND cr.campaign_id = $3`,
    [params.campaignRecipientId, params.tenantId, params.campaignId]
  );

  const state = row.rows[0];
  if (!state) {
    return {
      allowed: false,
      code: 'RECIPIENT_ALREADY_HANDLED',
      userMessage: 'Kampanya durduruldu',
      outboundStatus: 'CANCELLED',
      recipientStatus: 'CANCELLED',
    };
  }

  const campaignStatus = String(state.campaign_status || '').toUpperCase();
  if (campaignStatus === 'PAUSED' || campaignStatus === 'CANCELLED') {
    return {
      allowed: false,
      code: 'CAMPAIGN_STOPPED',
      userMessage: 'Kampanya durduruldu',
      outboundStatus: 'CANCELLED',
      recipientStatus: campaignStatus === 'CANCELLED' ? 'CANCELLED' : 'SKIPPED',
    };
  }

  const recipientStatus = String(state.recipient_status || '').toUpperCase();
  if (TERMINAL_RECIPIENT_STATUSES.has(recipientStatus)) {
    return {
      allowed: false,
      code: 'RECIPIENT_ALREADY_HANDLED',
      userMessage:
        recipientStatus === 'SENT'
          ? 'Bu alıcıya zaten gönderildi'
          : 'Kampanya durduruldu',
      outboundStatus: 'CANCELLED',
      recipientStatus: recipientStatus === 'CANCELLED' ? 'CANCELLED' : 'SKIPPED',
    };
  }

  return null;
}

async function checkSuppressionForAddresses(params: {
  tenantId: number;
  addresses: string[];
}): Promise<PreSendGateResult | null> {
  const normalized = params.addresses
    .map((a) => {
      const email = normalizeEmail(a);
      return email.ok ? email.normalized : normalizeEmailAddress(a);
    })
    .filter(Boolean);

  if (normalized.length === 0) return null;

  const suppressions = await findSuppressedEmails(params.tenantId, normalized);
  for (const address of normalized) {
    const hit = suppressions.get(address);
    if (!hit) continue;

    const reason = String(hit.reason || '').toUpperCase() as SuppressionReason | string;
    let code: PreSendGateBlockCode = 'SUPPRESSION_BLOCKED';
    if (reason === 'UNSUBSCRIBED') code = 'UNSUBSCRIBED';
    else if (reason === 'BOUNCE_PERMANENT') code = 'BOUNCE_PERMANENT';
    else if (reason === 'SPAM_COMPLAINT') code = 'SPAM_COMPLAINT';

    return {
      allowed: false,
      code,
      userMessage: userMessageForSuppression(reason),
      outboundStatus: 'CANCELLED',
      recipientStatus: 'SKIPPED',
    };
  }

  return null;
}

async function checkMarketingPreferences(params: {
  tenantId: number;
  brandId?: number | null;
  addresses: string[];
}): Promise<PreSendGateResult | null> {
  for (const address of params.addresses) {
    const result = await checkRecipientEligibility({
      tenantId: params.tenantId,
      channelType: 'EMAIL',
      value: address,
      brandId: params.brandId ?? null,
      strictPreference: false,
    });

    if (!result.eligible) {
      const blocked = blockFromEligibility(result);
      if (blocked) return blocked;
      continue;
    }

    if (!result.contactId) continue;

    const pref = String(result.preferenceStatus || 'UNKNOWN').toUpperCase();
    if (pref === 'OPTED_OUT' || pref === 'BLOCKED') {
      return {
        allowed: false,
        code: 'NO_PERMISSION',
        userMessage: 'İletişim izni bulunmuyor',
        outboundStatus: 'CANCELLED',
        recipientStatus: 'SKIPPED',
      };
    }
  }

  return null;
}

async function checkTransactionalPreferences(params: {
  tenantId: number;
  brandId?: number | null;
  addresses: string[];
}): Promise<PreSendGateResult | null> {
  for (const address of params.addresses) {
    const result = await checkRecipientEligibility({
      tenantId: params.tenantId,
      channelType: 'EMAIL',
      value: address,
      brandId: params.brandId ?? null,
      strictPreference: false,
    });

    if (!result.eligible) {
      const code = String(result.code || '').toUpperCase();
      if (code === 'BLOCKED' || code === 'CONTACT_BLOCKED') {
        return {
          allowed: false,
          code: 'CONTACT_BLOCKED',
          userMessage: 'İletişim izni bulunmuyor',
          outboundStatus: 'CANCELLED',
          recipientStatus: 'SKIPPED',
        };
      }
    }
  }

  return null;
}

/**
 * Final DB-backed gate immediately before SMTP for outbound EMAIL workers.
 */
export async function evaluateEmailPreSendGate(
  ctx: OutboundEmailGateContext
): Promise<PreSendGateResult> {
  const policy = resolveEmailSendPolicy(ctx);
  const addresses = ctx.toAddresses.filter(Boolean);
  if (addresses.length === 0) {
    return { allowed: true };
  }

  if (policy === 'transactional') {
    const prefBlock = await checkTransactionalPreferences({
      tenantId: ctx.tenantId,
      brandId: ctx.brandId,
      addresses,
    });
    return prefBlock || { allowed: true };
  }

  if (policy === 'marketing') {
    if (ctx.campaignId && ctx.campaignRecipientId) {
      const campaignBlock = await checkMarketingCampaignState({
        tenantId: ctx.tenantId,
        campaignId: Number(ctx.campaignId),
        campaignRecipientId: Number(ctx.campaignRecipientId),
      });
      if (campaignBlock) return campaignBlock;
    }

    const suppressionBlock = await checkSuppressionForAddresses({
      tenantId: ctx.tenantId,
      addresses,
    });
    if (suppressionBlock) return suppressionBlock;

    const permissionBlock = await checkMarketingPreferences({
      tenantId: ctx.tenantId,
      brandId: ctx.brandId,
      addresses,
    });
    if (permissionBlock) return permissionBlock;

    return { allowed: true };
  }

  // Standard compose / automation: honor suppressions + hard blocks, not strict OPTED_IN.
  const suppressionBlock = await checkSuppressionForAddresses({
    tenantId: ctx.tenantId,
    addresses,
  });
  if (suppressionBlock) return suppressionBlock;

  const prefBlock = await checkTransactionalPreferences({
    tenantId: ctx.tenantId,
    brandId: ctx.brandId,
    addresses,
  });
  return prefBlock || { allowed: true };
}
