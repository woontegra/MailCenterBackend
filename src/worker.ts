import dotenv from 'dotenv';
dotenv.config();

import { mailFetchWorker, mailSendWorker } from './queues/mailWorkers';
import { automationWorker } from './queues/automationWorker';
import { OAuthService } from './services/oauthService';
import { BackupService } from './services/backupService';
import logger from './config/logger';
import { assertRedisConfigForQueue, isMailQueueEnabled, pingRedis } from './config/redis';

logger.info('Worker process started');

async function boot() {
  try {
    assertRedisConfigForQueue();
  } catch (error: any) {
    logger.error(error?.message || 'Redis configuration error');
    process.exit(1);
  }

  const ping = await pingRedis();
  if (!ping.ok) {
    logger.error('Redis unavailable for worker');
    if (isMailQueueEnabled()) {
      process.exit(1);
    }
  }

  logger.info('Worker ready - listening for jobs');
}

const oauthService = new OAuthService();
const backupService = new BackupService();

setInterval(async () => {
  logger.info('Refreshing expired OAuth tokens...');
  await oauthService.refreshExpiredTokens();
}, 30 * 60 * 1000);

setInterval(async () => {
  logger.info('Running daily backup...');
  await backupService.createBackup();
  await backupService.cleanOldBackups(7);
}, 24 * 60 * 60 * 1000);

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, closing workers...');
  await mailFetchWorker.close();
  await mailSendWorker.close();
  await automationWorker.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, closing workers...');
  await mailFetchWorker.close();
  await mailSendWorker.close();
  await automationWorker.close();
  process.exit(0);
});

boot();
