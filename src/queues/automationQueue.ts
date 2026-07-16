import { Queue } from 'bullmq';
import redis, { isMailQueueEnabled, pingRedis } from '../config/redis';

export const automationQueue = new Queue('automation', { connection: redis });

export function isAutomationQueueEnabled(): boolean {
  const raw = (process.env.AUTOMATION_QUEUE_ENABLED || '').trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return isMailQueueEnabled();
}

export async function assertAutomationQueueReady(): Promise<{ ok: boolean; error?: string }> {
  if (!isAutomationQueueEnabled()) {
    return {
      ok: false,
      error: 'Otomasyon kuyruğu kapalı. AUTOMATION_QUEUE_ENABLED / MAIL_QUEUE_ENABLED yapılandırın.',
    };
  }
  const ping = await pingRedis();
  if (!ping.ok) {
    return { ok: false, error: ping.error || 'Redis kullanılamıyor' };
  }
  return { ok: true };
}

export async function enqueueAutomationExecution(
  executionId: number,
  tenantId: number,
  delayMs = 0
) {
  const ready = await assertAutomationQueueReady();
  if (!ready.ok) {
    const err = new Error(ready.error || 'Automation queue unavailable');
    (err as any).code = 'AUTOMATION_QUEUE_UNAVAILABLE';
    throw err;
  }

  const jobId =
    delayMs > 0
      ? `auto-exec-${executionId}-d${Date.now()}`
      : `auto-exec-${executionId}`;

  try {
    return await automationQueue.add(
      'process-execution',
      { executionId, tenantId },
      {
        jobId,
        delay: delayMs > 0 ? delayMs : undefined,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 200,
        removeOnFail: 100,
      }
    );
  } catch (error: any) {
    const msg = String(error?.message || '');
    if (msg.toLowerCase().includes('exists')) return null;
    throw error;
  }
}

export async function enqueueAutomationAction(
  actionExecutionId: number,
  tenantId: number,
  delayMs = 0
) {
  const ready = await assertAutomationQueueReady();
  if (!ready.ok) {
    const err = new Error(ready.error || 'Automation queue unavailable');
    (err as any).code = 'AUTOMATION_QUEUE_UNAVAILABLE';
    throw err;
  }

  const jobId =
    delayMs > 0
      ? `auto-act-${actionExecutionId}-d${Date.now()}`
      : `auto-act-${actionExecutionId}`;

  try {
    return await automationQueue.add(
      'process-action',
      { actionExecutionId, tenantId },
      {
        jobId,
        delay: delayMs > 0 ? delayMs : undefined,
        attempts: 3,
        backoff: { type: 'exponential', delay: 4000 },
        removeOnComplete: 200,
        removeOnFail: 100,
      }
    );
  } catch (error: any) {
    const msg = String(error?.message || '');
    if (msg.toLowerCase().includes('exists')) return null;
    throw error;
  }
}
