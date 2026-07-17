import { Worker, Job } from 'bullmq';
import redis from '../config/redis';
import { MailFetchService } from '../services/mailFetchService';
import { processOutboundEmailMessage } from '../services/outboundSendProcessor';
import { processOutboundSmsMessage } from '../services/outboundSmsProcessor';
import { processOutboundWhatsAppMessage } from '../services/outboundWhatsAppProcessor';
import { enqueueOutboundSend } from './mailQueue';
import { logError, logInfo } from '../config/logger';
import { getOutboundMessageForTenant } from '../services/outboundMessageService';
import { processCampaignDispatchBatch } from '../services/campaignDispatchService';
import { promoteScheduledCampaigns } from '../services/campaignService';

const mailFetchService = new MailFetchService();

export const mailFetchWorker = new Worker(
  'mail-fetch',
  async (job: Job) => {
    const { accountId, tenantId } = job.data;
    logInfo('Processing mail fetch / reconcile job', { accountId, tenantId });
    try {
      if (accountId) {
        await mailFetchService.fetchAccountById(Number(accountId), tenantId ? Number(tenantId) : undefined);
      } else {
        await mailFetchService.fetchAllAccounts();
      }
      logInfo('Mail fetch / reconcile completed', { accountId, tenantId });
    } catch (error: any) {
      logError(error, { accountId, tenantId });
      throw error;
    }
  },
  {
    connection: redis,
    concurrency: 5,
    limiter: { max: 10, duration: 1000 },
  }
);

async function processOutboundByChannel(outboundMessageId: number, tenantId: number) {
  const row = await getOutboundMessageForTenant(outboundMessageId, tenantId);
  if (!row) {
    return { outcome: 'skipped' as const, reason: 'not_found' };
  }
  if (row.channel_type === 'SMS') {
    return processOutboundSmsMessage(outboundMessageId, tenantId);
  }
  if (row.channel_type === 'WHATSAPP') {
    return processOutboundWhatsAppMessage(outboundMessageId, tenantId);
  }
  return processOutboundEmailMessage(outboundMessageId, tenantId);
}

export const mailSendWorker = new Worker(
  'mail-send',
  async (job: Job) => {
    if (job.name === 'outbound-send') {
      const outboundMessageId = Number(job.data.outboundMessageId);
      const tenantId = Number(job.data.tenantId);
      logInfo('Processing outbound send job', { outboundMessageId, tenantId });

      const result = await processOutboundByChannel(outboundMessageId, tenantId);

      if (result.outcome === 'delayed') {
        await enqueueOutboundSend(outboundMessageId, tenantId, result.delayMs);
        logInfo('Outbound message delayed', {
          outboundMessageId,
          tenantId,
          code: result.code,
        });
        return result;
      }

      if (result.outcome === 'failed') {
        logInfo('Outbound message failed permanently', {
          outboundMessageId,
          tenantId,
          code: result.code,
        });
        return result;
      }

      logInfo('Outbound message processed', {
        outboundMessageId,
        tenantId,
        outcome: result.outcome,
      });
      return result;
    }

    if (job.name === 'campaign-dispatch') {
      const campaignId = Number(job.data.campaignId);
      const tenantId = Number(job.data.tenantId);
      logInfo('Processing campaign dispatch batch', { campaignId, tenantId });
      const result = await processCampaignDispatchBatch(campaignId, tenantId);
      logInfo('Campaign dispatch batch finished', { campaignId, tenantId, ...result });
      return result;
    }

    if (job.name === 'campaign-scheduler-tick') {
      const promoted = await promoteScheduledCampaigns();
      logInfo('Campaign scheduler tick', { promoted });
      return { promoted };
    }

    // Legacy path: do not process request blobs that may contain secrets in logs
    logInfo('Ignoring legacy send job name', { name: job.name, jobId: job.id });
    return { outcome: 'skipped', reason: 'legacy_job' };
  },
  {
    connection: redis,
    concurrency: 3,
    limiter: { max: 5, duration: 1000 },
  }
);

mailFetchWorker.on('completed', (job) => {
  logInfo(`Fetch job ${job.id} completed`);
});

mailFetchWorker.on('failed', (job, err) => {
  logError(new Error(`Fetch job ${job?.id} failed: ${err.message}`));
});

mailSendWorker.on('completed', (job) => {
  logInfo(`Send job ${job.id} completed`);
});

mailSendWorker.on('failed', (job, err) => {
  logError(new Error(`Send job ${job?.id} failed: ${err.message}`));
});
