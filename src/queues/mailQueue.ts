import { Queue, Worker, Job } from 'bullmq';
import redis from '../config/redis';
import { MailFetchService } from '../services/mailFetchService';
import { SmtpService } from '../services/smtpService';
import { logError, logInfo } from '../config/logger';

export const mailFetchQueue = new Queue('mail-fetch', { connection: redis });
export const mailSendQueue = new Queue('mail-send', { connection: redis });

const mailFetchService = new MailFetchService();
const smtpService = new SmtpService();

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
    limiter: {
      max: 10,
      duration: 1000,
    },
  }
);

export const mailSendWorker = new Worker(
  'mail-send',
  async (job: Job) => {
    const { request, tenantId } = job.data;
    logInfo('Processing mail send job', { tenantId });
    
    try {
      const result = await smtpService.sendMail(request, tenantId);
      logInfo('Mail sent successfully', { tenantId, messageId: result.messageId });
      return result;
    } catch (error: any) {
      logError(error, { tenantId, request });
      throw error;
    }
  },
  {
    connection: redis,
    concurrency: 3,
    limiter: {
      max: 5,
      duration: 1000,
    },
  }
);

mailFetchWorker.on('completed', (job) => {
  logInfo(`Job ${job.id} completed`);
});

mailFetchWorker.on('failed', (job, err) => {
  logError(new Error(`Job ${job?.id} failed: ${err.message}`));
});

mailSendWorker.on('completed', (job) => {
  logInfo(`Send job ${job.id} completed`);
});

mailSendWorker.on('failed', (job, err) => {
  logError(new Error(`Send job ${job?.id} failed: ${err.message}`));
});

export const addMailFetchJob = async (accountId: number, tenantId: number) => {
  await mailFetchQueue.add(
    'fetch',
    { accountId, tenantId },
    {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000,
      },
      removeOnComplete: 100,
      removeOnFail: 50,
    }
  );
};

export const addMailSendJob = async (request: any, tenantId: number) => {
  return await mailSendQueue.add(
    'send',
    { request, tenantId },
    {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 3000,
      },
      removeOnComplete: 100,
      removeOnFail: 50,
    }
  );
};
