import dotenv from 'dotenv';
dotenv.config();

import { mailFetchWorker, mailSendWorker } from './queues/mailWorkers';
import { automationWorker } from './queues/automationWorker';
import { OAuthService } from './services/oauthService';
import { BackupService } from './services/backupService';
import logger from './config/logger';
import { assertRedisConfigForQueue, isMailQueueEnabled, pingRedis } from './config/redis';
import { assertImapIdleConfig, isImapIdleEnabled } from './config/imapIdleConfig';
import { getImapConnectionManager } from './services/imapConnectionManager';

logger.info('Worker process started');

const imapManager = getImapConnectionManager();

async function boot() {
  try {
    assertRedisConfigForQueue();
    assertImapIdleConfig();
  } catch (error: any) {
    logger.error(error?.message || 'Configuration error');
    process.exit(1);
  }

  const ping = await pingRedis();
  if (!ping.ok) {
    logger.error('Redis unavailable for worker');
    if (isMailQueueEnabled() || isImapIdleEnabled()) {
      process.exit(1);
    }
  }

  if (isImapIdleEnabled()) {
    await imapManager.start();
    logger.info('IMAP IDLE connection manager started');
  } else {
    logger.info('IMAP IDLE disabled — inbound sync relies on reconciliation jobs/cron');
  }

  // Promote scheduled campaigns and keep ticking
  const { promoteScheduledCampaigns } = await import('./services/campaignService');
  setInterval(async () => {
    try {
      await promoteScheduledCampaigns();
    } catch (err: any) {
      logger.error(err?.message || 'Campaign scheduler error');
    }
  }, 60 * 1000);

  try {
    const { query } = await import('./config/database');
    const { enqueueCampaignDispatch } = await import('./queues/mailQueue');
    const active = await query(
      `SELECT id, tenant_id FROM campaigns WHERE status IN ('QUEUED', 'SENDING')`
    );
    for (const row of active.rows) {
      await enqueueCampaignDispatch(row.id, row.tenant_id);
    }
    if (active.rows.length > 0) {
      logger.info(`Re-enqueued ${active.rows.length} active campaign dispatch jobs`);
    }
  } catch (err: any) {
    logger.error(err?.message || 'Campaign recovery error');
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

async function shutdown(signal: string) {
  logger.info(`${signal} received, closing workers...`);
  try {
    await imapManager.stop();
  } catch (err: any) {
    logger.error(err?.message || 'IMAP manager stop error');
  }
  await mailFetchWorker.close();
  await mailSendWorker.close();
  await automationWorker.close();
  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

boot();
