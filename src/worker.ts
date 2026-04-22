import dotenv from 'dotenv';
import { mailFetchWorker, mailSendWorker } from './queues/mailQueue';
import { OAuthService } from './services/oauthService';
import { BackupService } from './services/backupService';
import logger from './config/logger';

dotenv.config();

logger.info('Worker process started');

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
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, closing workers...');
  await mailFetchWorker.close();
  await mailSendWorker.close();
  process.exit(0);
});

logger.info('Worker ready - listening for jobs');
