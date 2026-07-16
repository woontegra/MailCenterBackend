import { Worker, Job } from 'bullmq';
import redis from '../config/redis';
import { MailFetchService } from '../services/mailFetchService';
import { processOutboundEmailMessage } from '../services/outboundSendProcessor';
import { processOutboundSmsMessage } from '../services/outboundSmsProcessor';
import { processOutboundWhatsAppMessage } from '../services/outboundWhatsAppProcessor';
import { enqueueOutboundSend } from './mailQueue';
import { logError, logInfo } from '../config/logger';
import { getOutboundMessageForTenant } from '../services/outboundMessageService';

const mailFetchService = new MailFetchService();

export const mailFetchWorker = new Worker(
  'mail-fetch',
  async (job: Job) => {
    const { accountId, tenantId } = job.data;
    logInfo('Processing mail fetch job', { accountId, tenantId });
    try {
      await mailFetchService.fetchAllAccounts();
      logInfo('Mail fetch completed', { accountId, tenantId });
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
