import { query, getClient } from '../config/database';
import {
  AudienceConfig,
  previewAudienceCount,
  prepareCampaignRecipients,
} from './campaignRecipientResolver';
import { renderTemplateContent } from '../utils/templateRenderer';
import { hasRequiredBulkBlocks } from '../utils/emailBlockCompiler';
import { resolveEligibleSenderIdentity } from '../utils/senderIdentityAccess';
import { createOutboundMessage } from './outboundMessageService';
import { enqueueOutboundSend } from '../queues/mailQueue';
import { sanitizeOutboundErrorMessage } from '../config/outboundQueue';
import { getOrCreateUnsubscribeUrl } from './campaignUnsubscribeService';
import { humanizeCampaignRecipientError } from '../utils/humanizeEligibility';

export type CampaignStatus =
  | 'DRAFT'
  | 'SCHEDULED'
  | 'QUEUED'
  | 'SENDING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

const EDITABLE_STATUSES = new Set<CampaignStatus>(['DRAFT', 'PAUSED']);

export const campaignConfig = {
  dispatchBatchSize: Math.max(
    1,
    parseInt(process.env.CAMPAIGN_DISPATCH_BATCH_SIZE || '25', 10) || 25
  ),
  dispatchDelayMs: Math.max(
    500,
    parseInt(process.env.CAMPAIGN_DISPATCH_DELAY_MS || '2000', 10) || 2000
  ),
};

function parseAudience(raw: unknown): AudienceConfig {
  if (!raw || typeof raw !== 'object') return { mode: 'ALL' };
  const o = raw as Record<string, unknown>;
  return {
    mode: (o.mode as AudienceConfig['mode']) || 'ALL',
    tag_ids: Array.isArray(o.tag_ids) ? o.tag_ids.map(Number).filter(Boolean) : [],
    company_name: o.company_name ? String(o.company_name) : undefined,
    contact_ids: Array.isArray(o.contact_ids) ? o.contact_ids.map(Number).filter(Boolean) : [],
    segment_id: o.segment_id ? Number(o.segment_id) : undefined,
    import_id: o.import_id ? Number(o.import_id) : undefined,
  };
}

export async function getCampaignForTenant(tenantId: number, campaignId: number) {
  const result = await query(
    `SELECT c.*, b.name AS brand_name, t.name AS template_name,
            u.email AS created_by_email,
            si.display_name AS sender_display_name, si.sender_value
     FROM campaigns c
     LEFT JOIN brands b ON b.id = c.brand_id AND b.tenant_id = c.tenant_id
     LEFT JOIN templates t ON t.id = c.template_id AND t.tenant_id = c.tenant_id
     LEFT JOIN users u ON u.id = c.created_by
     LEFT JOIN sender_identities si ON si.id = c.sender_identity_id AND si.tenant_id = c.tenant_id
     WHERE c.id = $1 AND c.tenant_id = $2`,
    [campaignId, tenantId]
  );
  return result.rows[0] || null;
}

export async function listCampaigns(tenantId: number, params?: { brand_id?: number; q?: string }) {
  const values: unknown[] = [tenantId];
  let sql = `
    SELECT c.*, b.name AS brand_name, u.email AS created_by_email
    FROM campaigns c
    LEFT JOIN brands b ON b.id = c.brand_id AND b.tenant_id = c.tenant_id
    LEFT JOIN users u ON u.id = c.created_by
    WHERE c.tenant_id = $1
  `;
  if (params?.brand_id) {
    values.push(params.brand_id);
    sql += ` AND c.brand_id = $${values.length}`;
  }
  if (params?.q?.trim()) {
    values.push(`%${params.q.trim()}%`);
    sql += ` AND c.name ILIKE $${values.length}`;
  }
  sql += ' ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC';
  const result = await query(sql, values);
  return result.rows;
}

async function assertBrand(tenantId: number, brandId: number | null) {
  if (!brandId) return false;
  const r = await query(`SELECT id FROM brands WHERE id = $1 AND tenant_id = $2`, [
    brandId,
    tenantId,
  ]);
  return r.rows.length > 0;
}

async function assertTemplate(tenantId: number, templateId: number | null, brandId: number | null) {
  if (!templateId) return { ok: false as const, error: 'Şablon seçilmedi' };
  const r = await query(
    `SELECT * FROM templates WHERE id = $1 AND tenant_id = $2 AND channel_type = 'EMAIL'`,
    [templateId, tenantId]
  );
  if (r.rows.length === 0) return { ok: false as const, error: 'Şablon bulunamadı' };
  const tpl = r.rows[0];
  if (brandId && tpl.brand_id && Number(tpl.brand_id) !== Number(brandId)) {
    return { ok: false as const, error: 'Şablon seçilen markaya ait değil' };
  }
  return { ok: true as const, template: tpl };
}

export async function createCampaignDraft(params: {
  tenantId: number;
  userId: number;
  name: string;
  brandId?: number | null;
  timezone?: string;
}) {
  if (params.brandId && !(await assertBrand(params.tenantId, params.brandId))) {
    throw Object.assign(new Error('Marka bulunamadı'), { status: 400 });
  }
  const result = await query(
    `INSERT INTO campaigns (tenant_id, brand_id, name, status, created_by, timezone, audience_config)
     VALUES ($1, $2, $3, 'DRAFT', $4, $5, $6::jsonb)
     RETURNING *`,
    [
      params.tenantId,
      params.brandId || null,
      String(params.name).trim(),
      params.userId,
      params.timezone || 'UTC',
      JSON.stringify({ mode: 'ALL' }),
    ]
  );
  return result.rows[0];
}

export async function updateCampaignDraft(
  tenantId: number,
  campaignId: number,
  patch: Record<string, unknown>
) {
  const existing = await getCampaignForTenant(tenantId, campaignId);
  if (!existing) return null;
  if (!EDITABLE_STATUSES.has(existing.status)) {
    throw Object.assign(new Error('Bu kampanya düzenlenemez'), { status: 409 });
  }

  const fields: string[] = [];
  const values: unknown[] = [campaignId, tenantId];
  const set = (col: string, val: unknown) => {
    values.push(val);
    fields.push(`${col} = $${values.length}`);
  };

  if (patch.name !== undefined) set('name', String(patch.name).trim());
  if (patch.brand_id !== undefined || patch.brandId !== undefined) {
    const brandId = patch.brand_id ?? patch.brandId;
    const n = brandId ? Number(brandId) : null;
    if (n && !(await assertBrand(tenantId, n))) {
      throw Object.assign(new Error('Marka bulunamadı'), { status: 400 });
    }
    set('brand_id', n);
  }
  if (patch.subject !== undefined) set('subject', patch.subject ? String(patch.subject) : null);
  if (patch.preheader !== undefined) set('preheader', patch.preheader ? String(patch.preheader) : null);
  if (patch.template_id !== undefined || patch.templateId !== undefined) {
    set('template_id', patch.template_id ?? patch.templateId ?? null);
  }
  if (patch.sender_account_id !== undefined || patch.senderAccountId !== undefined) {
    set('sender_account_id', patch.sender_account_id ?? patch.senderAccountId ?? null);
  }
  if (patch.sender_identity_id !== undefined || patch.senderIdentityId !== undefined) {
    set('sender_identity_id', patch.sender_identity_id ?? patch.senderIdentityId ?? null);
  }
  if (patch.reply_to !== undefined || patch.replyTo !== undefined) {
    set('reply_to', patch.reply_to ?? patch.replyTo ?? null);
  }
  if (patch.audience_config !== undefined || patch.audienceConfig !== undefined) {
    const aud = parseAudience(patch.audience_config ?? patch.audienceConfig);
    set('audience_config', JSON.stringify(aud));
  }
  if (patch.timezone !== undefined) set('timezone', String(patch.timezone || 'UTC'));
  if (patch.scheduled_at !== undefined || patch.scheduledAt !== undefined) {
    const raw = patch.scheduled_at ?? patch.scheduledAt;
    set('scheduled_at', raw ? new Date(String(raw)).toISOString() : null);
  }

  if (fields.length === 0) return existing;

  fields.push('updated_at = CURRENT_TIMESTAMP');
  const result = await query(
    `UPDATE campaigns SET ${fields.join(', ')}
     WHERE id = $1 AND tenant_id = $2
     RETURNING *`,
    values
  );
  return result.rows[0] || null;
}

export async function duplicateCampaign(tenantId: number, campaignId: number, userId: number) {
  const src = await getCampaignForTenant(tenantId, campaignId);
  if (!src) return null;
  const result = await query(
    `INSERT INTO campaigns (
       tenant_id, brand_id, name, subject, preheader, template_id,
       sender_account_id, sender_identity_id, reply_to, status, audience_config,
       timezone, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'DRAFT',$10::jsonb,$11,$12)
     RETURNING *`,
    [
      tenantId,
      src.brand_id,
      `${src.name} (kopya)`,
      src.subject,
      src.preheader,
      src.template_id,
      src.sender_account_id,
      src.sender_identity_id,
      src.reply_to,
      JSON.stringify(src.audience_config || { mode: 'ALL' }),
      src.timezone || 'UTC',
      userId,
    ]
  );
  return result.rows[0];
}

export type ValidationIssue = { code: string; message: string };

export async function validateCampaignForLaunch(
  tenantId: number,
  campaignId: number
): Promise<{ ok: boolean; issues: ValidationIssue[] }> {
  const issues: ValidationIssue[] = [];
  const campaign = await getCampaignForTenant(tenantId, campaignId);
  if (!campaign) {
    return { ok: false, issues: [{ code: 'NOT_FOUND', message: 'Kampanya bulunamadı' }] };
  }

  if (!campaign.brand_id) issues.push({ code: 'BRAND', message: 'Marka seçilmedi' });
  if (!campaign.subject?.trim()) issues.push({ code: 'SUBJECT', message: 'Konu boş olamaz' });

  const tplCheck = await assertTemplate(tenantId, campaign.template_id, campaign.brand_id);
  if (!tplCheck.ok) {
    issues.push({ code: 'TEMPLATE', message: tplCheck.error });
  } else {
    const tpl = tplCheck.template;
    if (tpl.editor_json?.blocks) {
      const req = hasRequiredBulkBlocks(tpl.editor_json.blocks);
      if (!req.company) issues.push({ code: 'FOOTER', message: 'Şablonda şirket bilgisi bloğu gerekli' });
      if (!req.unsubscribe) {
        issues.push({ code: 'UNSUBSCRIBE', message: 'Şablonda abonelikten çıkma bloğu gerekli' });
      }
    } else if (!String(tpl.content || '').toLowerCase().includes('abonelik')) {
      issues.push({
        code: 'UNSUBSCRIBE',
        message: 'Şablonda abonelikten çıkma alanı bulunamadı',
      });
    }
  }

  if (!campaign.sender_identity_id) {
    issues.push({ code: 'SENDER', message: 'Gönderim kimliği seçilmedi' });
  } else {
    const sender = await resolveEligibleSenderIdentity(
      Number(campaign.sender_identity_id),
      tenantId
    );
    if (!sender) {
      issues.push({ code: 'SENDER', message: 'Gönderen hesap aktif veya doğrulanmış değil' });
    }
  }

  const audience = parseAudience(campaign.audience_config);
  const preview = await previewAudienceCount({
    tenantId,
    brandId: campaign.brand_id ? Number(campaign.brand_id) : null,
    audience,
  });
  if (preview.count === 0) {
    issues.push({ code: 'RECIPIENTS', message: 'En az bir alıcı gerekli' });
  }

  return { ok: issues.length === 0, issues };
}

export async function snapshotCampaignRecipients(tenantId: number, campaignId: number) {
  const campaign = await getCampaignForTenant(tenantId, campaignId);
  if (!campaign) throw Object.assign(new Error('Kampanya bulunamadı'), { status: 404 });

  const audience = parseAudience(campaign.audience_config);
  const prepared = await prepareCampaignRecipients({
    tenantId,
    brandId: campaign.brand_id ? Number(campaign.brand_id) : null,
    audience,
  });
  const recipients = prepared.recipients;

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM campaign_recipients WHERE campaign_id = $1 AND tenant_id = $2`,
      [campaignId, tenantId]
    );

    for (const r of recipients) {
      await client.query(
        `INSERT INTO campaign_recipients (
           campaign_id, tenant_id, contact_id, email, email_normalized,
           display_name, personalisation_data, status, source, source_ref_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'PENDING',$8,$9)
         ON CONFLICT (campaign_id, email_normalized) DO NOTHING`,
        [
          campaignId,
          tenantId,
          r.contact_id,
          r.email,
          r.email_normalized,
          r.display_name,
          JSON.stringify(r.personalisation_data),
          r.source || 'audience',
          r.source_ref_id || null,
        ]
      );
    }

    const countRes = await client.query(
      `SELECT COUNT(*)::int AS c FROM campaign_recipients WHERE campaign_id = $1 AND tenant_id = $2`,
      [campaignId, tenantId]
    );

    await client.query(
      `UPDATE campaigns
       SET recipient_count = $3,
           recipient_summary = $4::jsonb,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND tenant_id = $2`,
      [campaignId, tenantId, countRes.rows[0]?.c || 0, JSON.stringify(prepared.summary)]
    );

    await client.query('COMMIT');
    return { count: countRes.rows[0]?.c || 0 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function buildTestUnsubscribeLink(): string {
  const base = process.env.FRONTEND_URL || 'https://example.com';
  return `${base.replace(/\/$/, '')}/unsubscribe/test`;
}

export async function renderCampaignMessage(params: {
  campaign: any;
  template: any;
  personalisation: Record<string, string>;
  test?: boolean;
  tenantId?: number;
  campaignId?: number;
  recipientId?: number;
  email?: string;
}) {
  const values = { ...params.personalisation };
  values.abonelikten_cikma_linki = params.test
    ? buildTestUnsubscribeLink()
    : await getOrCreateUnsubscribeUrl({
        tenantId: Number(params.tenantId || params.campaign.tenant_id),
        campaignId: Number(params.campaignId || params.campaign.id),
        recipientId: Number(params.recipientId),
        email: String(params.email || values.email || ''),
      });

  const rendered = renderTemplateContent({
    subject: params.campaign.subject || '',
    htmlContent: params.template.content || '',
    plainTextContent: params.template.plain_text_content || '',
    variables: params.template.variables || [],
    values,
  });

  const subject = params.test
    ? `[TEST] ${rendered.subject}`
    : rendered.subject;

  return {
    subject,
    htmlContent: rendered.htmlContent,
    plainTextContent: rendered.plainTextContent,
  };
}

export async function sendCampaignTestEmail(params: {
  tenantId: number;
  userId: number;
  campaignId: number;
  toEmail: string;
  includeTestPrefix?: boolean;
}) {
  const campaign = await getCampaignForTenant(params.tenantId, params.campaignId);
  if (!campaign) throw Object.assign(new Error('Kampanya bulunamadı'), { status: 404 });

  const tplCheck = await assertTemplate(params.tenantId, campaign.template_id, campaign.brand_id);
  if (!tplCheck.ok) throw Object.assign(new Error(tplCheck.error), { status: 400 });

  if (!campaign.sender_identity_id) {
    throw Object.assign(new Error('Gönderim kimliği seçilmedi'), { status: 400 });
  }

  const sample = {
    ad: 'Test',
    soyad: 'Kullanıcı',
    tam_ad: 'Test Kullanıcı',
    firma: 'Örnek Firma',
    email: params.toEmail,
    telefon: '+90 555 000 00 00',
    marka_adi: campaign.brand_name || 'Marka',
    abonelikten_cikma_linki: buildTestUnsubscribeLink(),
  };

  const rendered = await renderCampaignMessage({
    campaign,
    template: tplCheck.template,
    personalisation: sample,
    test: params.includeTestPrefix !== false,
    campaignId: campaign.id,
    recipientId: 0,
  });

  const idempotencyKey = `campaign-test:${params.campaignId}:${params.toEmail}:${Date.now()}`;
  const { row } = await createOutboundMessage({
    tenantId: params.tenantId,
    brandId: campaign.brand_id ? Number(campaign.brand_id) : null,
    channelType: 'EMAIL',
    senderIdentityId: Number(campaign.sender_identity_id),
    templateId: campaign.template_id,
    recipientData: {
      to: params.toEmail,
      replyTo: campaign.reply_to || undefined,
      contact_id: null,
      _campaign_test: true,
    },
    subject: rendered.subject,
    htmlContent: rendered.htmlContent,
    plainTextContent: rendered.plainTextContent,
    templateVariables: sample,
    status: 'QUEUED',
    idempotencyKey,
    createdBy: params.userId,
  });

  const { enqueueOutboundSend } = await import('../queues/mailQueue');
  await enqueueOutboundSend(row.id, params.tenantId);

  return { outboundMessageId: row.id };
}

export async function launchCampaign(params: {
  tenantId: number;
  campaignId: number;
  sendNow: boolean;
  scheduledAt?: Date | null;
}) {
  const validation = await validateCampaignForLaunch(params.tenantId, params.campaignId);
  if (!validation.ok) {
    throw Object.assign(new Error(validation.issues[0]?.message || 'Doğrulama başarısız'), {
      status: 400,
      issues: validation.issues,
    });
  }

  await snapshotCampaignRecipients(params.tenantId, params.campaignId);

  let status: CampaignStatus = 'QUEUED';
  let scheduledAt: string | null = null;

  if (!params.sendNow && params.scheduledAt) {
    status = 'SCHEDULED';
    scheduledAt = params.scheduledAt.toISOString();
  }

  await query(
    `UPDATE campaigns
     SET status = $3,
         scheduled_at = $4,
         started_at = CASE WHEN $3 = 'QUEUED' THEN COALESCE(started_at, CURRENT_TIMESTAMP) ELSE started_at END,
         paused_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND tenant_id = $2`,
    [params.campaignId, params.tenantId, status, scheduledAt]
  );

  if (status === 'QUEUED') {
    const { enqueueCampaignDispatch } = await import('../queues/mailQueue');
    await enqueueCampaignDispatch(params.campaignId, params.tenantId);
  }

  return getCampaignForTenant(params.tenantId, params.campaignId);
}

export async function pauseCampaign(tenantId: number, campaignId: number) {
  const campaign = await getCampaignForTenant(tenantId, campaignId);
  if (!campaign) return null;
  if (!['QUEUED', 'SENDING', 'SCHEDULED'].includes(campaign.status)) {
    throw Object.assign(new Error('Kampanya duraklatılamaz'), { status: 409 });
  }
  await query(
    `UPDATE campaigns SET status = 'PAUSED', paused_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND tenant_id = $2`,
    [campaignId, tenantId]
  );
  return getCampaignForTenant(tenantId, campaignId);
}

export async function resumeCampaign(tenantId: number, campaignId: number) {
  const campaign = await getCampaignForTenant(tenantId, campaignId);
  if (!campaign) return null;
  if (campaign.status !== 'PAUSED') {
    throw Object.assign(new Error('Kampanya devam ettirilemez'), { status: 409 });
  }
  await query(
    `UPDATE campaigns SET status = 'SENDING', paused_at = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND tenant_id = $2`,
    [campaignId, tenantId]
  );
  const { enqueueCampaignDispatch } = await import('../queues/mailQueue');
  await enqueueCampaignDispatch(campaignId, tenantId);
  return getCampaignForTenant(tenantId, campaignId);
}

export async function cancelCampaign(tenantId: number, campaignId: number) {
  const campaign = await getCampaignForTenant(tenantId, campaignId);
  if (!campaign) return null;
  if (['COMPLETED', 'CANCELLED'].includes(campaign.status)) {
    throw Object.assign(new Error('Kampanya iptal edilemez'), { status: 409 });
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE campaign_recipients
       SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP
       WHERE campaign_id = $1 AND tenant_id = $2 AND status IN ('PENDING', 'QUEUED')`,
      [campaignId, tenantId]
    );

    await client.query(
      `UPDATE outbound_messages
       SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP
       WHERE campaign_id = $1 AND tenant_id = $2 AND status IN ('QUEUED', 'SCHEDULED')`,
      [campaignId, tenantId]
    );

    await client.query(
      `UPDATE campaigns SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND tenant_id = $2`,
      [campaignId, tenantId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return getCampaignForTenant(tenantId, campaignId);
}

export async function listCampaignRecipients(
  tenantId: number,
  campaignId: number,
  limit = 50,
  offset = 0
) {
  const result = await query(
    `SELECT id, email, display_name, status, sent_at, last_error, outbound_message_id
     FROM campaign_recipients
     WHERE campaign_id = $1 AND tenant_id = $2
     ORDER BY id
     LIMIT $3 OFFSET $4`,
    [campaignId, tenantId, limit, offset]
  );
  return result.rows;
}

export async function syncCampaignRecipientFromOutbound(params: {
  tenantId: number;
  outboundMessageId: number;
  status: 'SENT' | 'FAILED';
  errorMessage?: string;
}) {
  const row = await query(
    `SELECT cr.id, cr.campaign_id, cr.status AS recipient_status, c.status AS campaign_status
     FROM campaign_recipients cr
     JOIN campaigns c ON c.id = cr.campaign_id AND c.tenant_id = cr.tenant_id
     WHERE cr.outbound_message_id = $1 AND cr.tenant_id = $2`,
    [params.outboundMessageId, params.tenantId]
  );
  if (row.rows.length === 0) return;

  const rec = row.rows[0];
  if (rec.recipient_status === 'SENT' || rec.recipient_status === 'CANCELLED') return;

  if (params.status === 'SENT') {
    await query(
      `UPDATE campaign_recipients
       SET status = 'SENT', sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND tenant_id = $2`,
      [rec.id, params.tenantId]
    );
    await query(
      `UPDATE campaigns SET sent_count = sent_count + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND tenant_id = $2`,
      [rec.campaign_id, params.tenantId]
    );
  } else {
    await query(
      `UPDATE campaign_recipients
       SET status = 'FAILED',
           last_error = $3,
           attempt_count = attempt_count + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND tenant_id = $2`,
      [rec.id, params.tenantId, sanitizeOutboundErrorMessage(
        humanizeCampaignRecipientError(params.errorMessage)
      )],
    );
    await query(
      `UPDATE campaigns SET failed_count = failed_count + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND tenant_id = $2`,
      [rec.campaign_id, params.tenantId]
    );
  }

  await maybeCompleteCampaign(params.tenantId, rec.campaign_id);
}

async function maybeCompleteCampaign(tenantId: number, campaignId: number) {
  const pending = await query(
    `SELECT COUNT(*)::int AS c FROM campaign_recipients
     WHERE campaign_id = $1 AND tenant_id = $2 AND status IN ('PENDING', 'QUEUED', 'SENDING')`,
    [campaignId, tenantId]
  );
  if ((pending.rows[0]?.c || 0) > 0) return;

  const failed = await query(
    `SELECT COUNT(*)::int AS c FROM campaign_recipients
     WHERE campaign_id = $1 AND tenant_id = $2 AND status = 'FAILED'`,
    [campaignId, tenantId]
  );

  const finalStatus = (failed.rows[0]?.c || 0) > 0 ? 'FAILED' : 'COMPLETED';
  await query(
    `UPDATE campaigns
     SET status = $3, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND tenant_id = $2 AND status NOT IN ('CANCELLED', 'PAUSED')`,
    [campaignId, tenantId, finalStatus]
  );
}

export async function promoteScheduledCampaigns() {
  const due = await query(
    `SELECT id, tenant_id FROM campaigns
     WHERE status = 'SCHEDULED' AND scheduled_at IS NOT NULL AND scheduled_at <= CURRENT_TIMESTAMP`
  );

  for (const row of due.rows) {
    await query(
      `UPDATE campaigns
       SET status = 'QUEUED', started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND tenant_id = $2 AND status = 'SCHEDULED'`,
      [row.id, row.tenant_id]
    );
    const { enqueueCampaignDispatch } = await import('../queues/mailQueue');
    await enqueueCampaignDispatch(row.id, row.tenant_id);
  }

  return due.rows.length;
}
