import { Queue } from 'bullmq';
import redis from '../config/redis';

/** Producer-only queues. Workers live in mailWorkers.ts (worker process only). */

export const mailFetchQueue = new Queue('mail-fetch', { connection: redis });
export const mailSendQueue = new Queue('mail-send', { connection: redis });

export async function addMailFetchJob(accountId: number, tenantId: number) {
  return mailFetchQueue.add(
    'fetch',
    { accountId, tenantId },
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 50,
    }
  );
}

export async function enqueueOutboundSend(
  outboundMessageId: number,
  tenantId: number,
  delayMs = 0
) {
  const jobId =
    delayMs > 0
      ? `outbound-${outboundMessageId}-d${Date.now()}`
      : `outbound-${outboundMessageId}`;

  try {
    return await mailSendQueue.add(
      'outbound-send',
      { outboundMessageId, tenantId },
      {
        jobId,
        delay: delayMs > 0 ? delayMs : undefined,
        attempts: 1,
        removeOnComplete: 200,
        removeOnFail: 100,
      }
    );
  } catch (error: any) {
    const msg = String(error?.message || '');
    if (msg.toLowerCase().includes('exists')) {
      return null;
    }
    throw error;
  }
}

/** @deprecated Prefer enqueueOutboundSend — kept for compatibility */
export async function addMailSendJob(request: any, tenantId: number) {
  return mailSendQueue.add(
    'send-legacy',
    { request, tenantId },
    {
      attempts: 1,
      removeOnComplete: 50,
      removeOnFail: 50,
    }
  );
}

export async function getMailSendQueueCounts() {
  return mailSendQueue.getJobCounts(
    'waiting',
    'active',
    'completed',
    'failed',
    'delayed',
    'paused'
  );
}
