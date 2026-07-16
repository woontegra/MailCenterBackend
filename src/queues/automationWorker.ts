import { Worker, Job } from 'bullmq';
import redis from '../config/redis';
import { logError, logInfo } from '../config/logger';
import {
  processAutomationExecution,
  processAutomationActionExecution,
} from '../services/automationEngine';

export const automationWorker = new Worker(
  'automation',
  async (job: Job) => {
    if (job.name === 'process-execution') {
      const { executionId, tenantId } = job.data;
      logInfo('Processing automation execution', { executionId, tenantId });
      await processAutomationExecution(Number(executionId), Number(tenantId));
      return;
    }
    if (job.name === 'process-action') {
      const { actionExecutionId, tenantId } = job.data;
      logInfo('Processing automation action', { actionExecutionId, tenantId });
      await processAutomationActionExecution(Number(actionExecutionId), Number(tenantId));
      return;
    }
  },
  {
    connection: redis,
    concurrency: 5,
    limiter: { max: 20, duration: 1000 },
  }
);

automationWorker.on('failed', (job, err) => {
  logError(err, {
    queue: 'automation',
    jobId: job?.id,
    name: job?.name,
    data: job?.data,
  });
});
