import { query } from '../config/database';
import { campaignConfig, getCampaignForTenant, renderCampaignMessage } from './campaignService';
import { createOutboundMessage } from './outboundMessageService';
import { enqueueOutboundSend, enqueueCampaignDispatch } from '../queues/mailQueue';
import { sanitizeOutboundErrorMessage } from '../config/outboundQueue';

export async function processCampaignDispatchBatch(
  campaignId: number,
  tenantId: number
): Promise<{ dispatched: number; done: boolean; paused: boolean }> {
  const campaign = await getCampaignForTenant(tenantId, campaignId);
  if (!campaign) return { dispatched: 0, done: true, paused: false };

  if (campaign.status === 'PAUSED' || campaign.status === 'CANCELLED') {
    return { dispatched: 0, done: true, paused: campaign.status === 'PAUSED' };
  }

  if (!['QUEUED', 'SENDING'].includes(campaign.status)) {
    return { dispatched: 0, done: true, paused: false };
  }

  if (campaign.status === 'QUEUED') {
    await query(
      `UPDATE campaigns SET status = 'SENDING', started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
       WHERE id = $1 AND tenant_id = $2 AND status = 'QUEUED'`,
      [campaignId, tenantId]
    );
  }

  const tplRes = await query(
    `SELECT * FROM templates WHERE id = $1 AND tenant_id = $2`,
    [campaign.template_id, tenantId]
  );
  const template = tplRes.rows[0];
  if (!template) {
    await query(
      `UPDATE campaigns SET status = 'FAILED', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND tenant_id = $2`,
      [campaignId, tenantId]
    );
    return { dispatched: 0, done: true, paused: false };
  }

  const batchRes = await query(
    `UPDATE campaign_recipients cr
     SET status = 'SENDING', updated_at = CURRENT_TIMESTAMP
     FROM (
       SELECT id FROM campaign_recipients
       WHERE campaign_id = $1 AND tenant_id = $2 AND status = 'PENDING'
       ORDER BY id
       LIMIT $3
     ) picked
     WHERE cr.id = picked.id AND cr.campaign_id = $1 AND cr.tenant_id = $2
     RETURNING cr.*`,
    [campaignId, tenantId, campaignConfig.dispatchBatchSize]
  );

  let dispatched = 0;

  for (const recipient of batchRes.rows) {
    const fresh = await getCampaignForTenant(tenantId, campaignId);
    if (!fresh || fresh.status === 'PAUSED' || fresh.status === 'CANCELLED') {
      return { dispatched, done: true, paused: fresh?.status === 'PAUSED' };
    }

    try {
      const personalisation =
        typeof recipient.personalisation_data === 'object'
          ? recipient.personalisation_data
          : JSON.parse(String(recipient.personalisation_data || '{}'));

      const rendered = await renderCampaignMessage({
        campaign,
        template,
        personalisation,
        tenantId,
        campaignId,
        recipientId: recipient.id,
        email: recipient.email,
      });

      const idempotencyKey = `campaign:${campaignId}:recipient:${recipient.id}`;

      const { row, created } = await createOutboundMessage({
        tenantId,
        brandId: campaign.brand_id ? Number(campaign.brand_id) : null,
        channelType: 'EMAIL',
        senderIdentityId: Number(campaign.sender_identity_id),
        templateId: campaign.template_id,
        recipientData: {
          to: recipient.email,
          replyTo: campaign.reply_to || undefined,
          contact_id: recipient.contact_id,
          _campaign: { campaignId, recipientId: recipient.id },
        },
        subject: rendered.subject,
        htmlContent: rendered.htmlContent,
        plainTextContent: rendered.plainTextContent,
        templateVariables: personalisation,
        status: 'QUEUED',
        idempotencyKey,
        createdBy: campaign.created_by,
        campaignId,
        campaignRecipientId: recipient.id,
      });

      await query(
        `UPDATE campaign_recipients
         SET status = 'QUEUED',
             outbound_message_id = $3,
             queued_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND tenant_id = $2 AND status = 'SENDING'`,
        [recipient.id, tenantId, row.id]
      );

      if (created) {
        await enqueueOutboundSend(row.id, tenantId);
        dispatched += 1;
      }
    } catch (error: any) {
      await query(
        `UPDATE campaign_recipients
         SET status = 'FAILED',
             last_error = $3,
             attempt_count = attempt_count + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND tenant_id = $2 AND status IN ('PENDING', 'SENDING')`,
        [
          recipient.id,
          tenantId,
          sanitizeOutboundErrorMessage(error?.message || 'Kuyruğa alınamadı'),
        ]
      );
      await query(
        `UPDATE campaigns SET failed_count = failed_count + 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND tenant_id = $2`,
        [campaignId, tenantId]
      );
    }
  }

  const remaining = await query(
    `SELECT COUNT(*)::int AS c FROM campaign_recipients
     WHERE campaign_id = $1 AND tenant_id = $2 AND status = 'PENDING'`,
    [campaignId, tenantId]
  );

  const pendingCount = remaining.rows[0]?.c || 0;
  const done = pendingCount === 0;

  if (!done) {
    await enqueueCampaignDispatch(campaignId, tenantId, campaignConfig.dispatchDelayMs);
  } else {
    const inFlight = await query(
      `SELECT COUNT(*)::int AS c FROM campaign_recipients
       WHERE campaign_id = $1 AND tenant_id = $2 AND status IN ('QUEUED', 'SENDING')`,
      [campaignId, tenantId]
    );
    if ((inFlight.rows[0]?.c || 0) === 0) {
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
  }

  return { dispatched, done, paused: false };
}
