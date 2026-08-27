import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { pool } from './config/database';
import { initializeSocket } from './services/socketService';
import { errorHandler } from './middleware/errorLogger';
import { MailFetchService } from './services/mailFetchService';
import { BackupService } from './services/backupService';
import { OAuthService } from './services/oauthService';
import logger from './config/logger';
import { assertRedisConfigForQueue, getRedisStatusSnapshot, pingRedis } from './config/redis';
import {
  assertImapIdleConfig,
  getImapReconcileIntervalMinutes,
  isImapIdleEnabled,
} from './config/imapIdleConfig';
import { getMailSendQueueCounts } from './queues/mailQueue';
import outboundMessageRoutes from './routes/outboundMessageRoutes';
import { emitToTenant } from './services/socketService';
import { subscribeInboxRealtime } from './services/redisEventBus';

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 5000;
const isProduction = process.env.NODE_ENV === 'production';

// Railway (and similar) sit behind exactly one reverse proxy.
// express-rate-limit requires trust proxy when X-Forwarded-For is present.
// Use hop count 1 — never `true` (ERR_ERL_PERMISSIVE_TRUST_PROXY).
if (isProduction) {
  app.set('trust proxy', 1);
}

if (isProduction && !process.env.FRONTEND_URL) {
  throw new Error(
    'Configuration error: FRONTEND_URL must be set in production for secure CORS.'
  );
}

assertRedisConfigForQueue();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP',
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many login attempts',
});

app.use(helmet());
app.use(cors({
  origin: isProduction ? process.env.FRONTEND_URL! : (process.env.FRONTEND_URL || '*'),
  credentials: true,
}));
app.use('/api/auth', authLimiter);
app.use('/api', limiter);
app.use(express.json({
  verify: (req: any, _res, buf) => {
    const url = String(req.originalUrl || '');
    if (
      url.startsWith('/api/webhooks/whatsapp') ||
      url.startsWith('/api/billing/webhook')
    ) {
      req.rawBody = Buffer.from(buf);
    }
  },
}));

import authRoutes from './routes/authRoutes';
import accountRoutes from './routes/accountRoutes';
import mailRoutes from './routes/mailRoutes.tenant';
import dashboardRoutes from './routes/dashboardRoutes.tenant';
import tagRoutes from './routes/tagRoutes.tenant';
import sendMailRoutes from './routes/sendMailRoutes.tenant';
import autoTagRoutes from './routes/autoTagRoutes';
import userRoutes from './routes/userRoutes';
import notificationRoutes from './routes/notificationRoutes';
import analyticsRoutes from './routes/analyticsRoutes';
import conversationRoutes from './routes/conversationRoutes';
import automationRoutes from './routes/automationRoutes';
import attachmentRoutes from './routes/attachmentRoutes';
import draftRoutes from './routes/draftRoutes';
import templateRoutes from './routes/templateRoutes';
import templateMediaRoutes from './routes/templateMediaRoutes';
import inviteRoutes from './routes/inviteRoutes';
import teamRoutes from './routes/teamRoutes';
import platformAdminRoutes from './routes/platformAdminRoutes';
import inboxGroupedRoutes from './routes/inboxGroupedRoutes';
import threadRoutes from './routes/threadRoutes';
import billingRoutes from './routes/billingRoutes';
import adminRoutes from './routes/adminRoutes';
import adminPlatformRoutes from './routes/adminPlatformRoutes';
import adminPlatformModules from './routes/adminPlatformModules';
import oauthRoutes from './routes/oauthRoutes';
import storageRoutes from './routes/storageRoutes';
import webhookRoutes from './routes/webhookRoutes';
import exportRoutes from './routes/exportRoutes';
import whiteLabelRoutes from './routes/whiteLabelRoutes';
import superAdminRoutes from './routes/superAdminRoutes';
import profileRoutes from './routes/profileRoutes';
import brandRoutes from './routes/brandRoutes';
import contactRoutes from './routes/contactRoutes';
import contactListRoutes from './routes/contactListRoutes';
import sendSmsRoutes from './routes/sendSmsRoutes';
import smsRoutes from './routes/smsRoutes';
import sendWhatsAppRoutes from './routes/sendWhatsAppRoutes';
import whatsappRoutes from './routes/whatsappRoutes';
import whatsappInboxRoutes from './routes/whatsappInboxRoutes';
import whatsappWebhookRoutes from './routes/whatsappWebhookRoutes';
import deliverabilityRoutes from './routes/deliverabilityRoutes';
import channelConnectionRoutes from './routes/channelConnectionRoutes';
import whatsappEmbeddedSignupRoutes from './routes/whatsappEmbeddedSignupRoutes';
import senderIdentityRoutes from './routes/senderIdentityRoutes';
import campaignRoutes from './routes/campaignRoutes';
import whatsappBulkCampaignRoutes from './routes/whatsappBulkCampaignRoutes';
import segmentRoutes from './routes/segmentRoutes';
import suppressionRoutes from './routes/suppressionRoutes';
import unsubscribeRoutes from './routes/unsubscribeRoutes';

app.use('/api/auth', authRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/mails', mailRoutes);
app.use('/api/threads', threadRoutes);
app.use('/api/tags', tagRoutes);
app.use('/api/brands', deliverabilityRoutes);
app.use('/api/brands', brandRoutes);
app.use('/api/channel-connections', whatsappEmbeddedSignupRoutes);
app.use('/api/channel-connections', channelConnectionRoutes);
app.use('/api/sender-identities', senderIdentityRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin-platform', adminPlatformRoutes);
app.use('/api/admin-platform', adminPlatformModules);
app.use('/api/oauth', oauthRoutes);
app.use('/api/storage', storageRoutes);
// Public Meta WhatsApp webhook endpoints MUST be mounted before the
// authenticated /api/webhooks router, otherwise its authenticate middleware
// intercepts GET /api/webhooks/whatsapp and returns 401 to Meta.
app.use('/api/webhooks/whatsapp/meta', whatsappWebhookRoutes);
app.use('/api/webhooks/whatsapp', whatsappWebhookRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/white-label', whiteLabelRoutes);
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/user', profileRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/send-mail', sendMailRoutes);
app.use('/api/send-sms', sendSmsRoutes);
app.use('/api/sms', smsRoutes);
app.use('/api/send-whatsapp', sendWhatsAppRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/inbox/whatsapp', whatsappInboxRoutes);
app.use('/api/auto-tag', autoTagRoutes);
app.use('/api/users', userRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/automation', automationRoutes);
app.use('/api/attachments', attachmentRoutes);
app.use('/api/drafts', draftRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/templates/media', templateMediaRoutes);
app.use('/api/outbound-messages', outboundMessageRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/whatsapp/campaigns', whatsappBulkCampaignRoutes);
app.use('/api/segments', segmentRoutes);
app.use('/api/suppressions', suppressionRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/contact-lists', contactListRoutes);
app.use('/api/team', teamRoutes);
app.use('/api/platform-admin', platformAdminRoutes);
app.use('/api/invites', inviteRoutes);
app.use('/api/inbox', inboxGroupedRoutes);
app.use('/unsubscribe', unsubscribeRoutes);

app.get('/api/health', async (req, res) => {
  let database: 'ok' | 'error' = 'error';
  try {
    await pool.query('SELECT 1');
    database = 'ok';
  } catch {
    database = 'error';
  }

  const redisPing = await pingRedis();
  const redisSnapshot = getRedisStatusSnapshot();

  let queue: Record<string, unknown> = {
    enabled: redisSnapshot.queueEnabled,
    status: 'unknown',
  };

  if (redisSnapshot.queueEnabled) {
    if (!redisPing.ok) {
      queue = { enabled: true, status: 'unavailable', error: redisPing.error };
    } else {
      try {
        const counts = await getMailSendQueueCounts();
        queue = { enabled: true, status: 'ok', counts };
      } catch (error: any) {
        queue = {
          enabled: true,
          status: 'error',
          error: error?.message ? String(error.message).slice(0, 120) : 'queue_error',
        };
      }
    }
  } else {
    queue = {
      enabled: false,
      status: 'disabled',
      syncFallbackAllowed: redisSnapshot.syncFallbackAllowed,
    };
  }

  const overall =
    database === 'ok' &&
    (!redisSnapshot.queueEnabled || redisPing.ok)
      ? 'ok'
      : 'degraded';

  res.status(overall === 'ok' ? 200 : 503).json({
    status: overall,
    timestamp: new Date().toISOString(),
    checks: {
      api: 'ok',
      database,
      redis: redisPing.ok ? 'ok' : 'error',
      queue,
    },
  });
});

app.use(errorHandler);

const startServer = async () => {
  try {
    assertImapIdleConfig();

    await pool.query('SELECT NOW()');
    console.log('✓ Database connected');

    initializeSocket(httpServer);
    console.log('✓ Socket.io initialized');

    // Bridge Redis inbox events from worker → Socket.IO (web process holds sockets)
    subscribeInboxRealtime((event) => {
      if (event.type === 'new_mail') {
        emitToTenant(event.tenantId, 'new_mail', {
          id: event.mailId,
          subject: event.subject,
          from: event.from,
          accountId: event.accountId,
          conversationId: event.conversationId,
        });
        emitToTenant(event.tenantId, 'conversation_updated', {
          conversationId: event.conversationId,
          mailId: event.mailId,
          accountId: event.accountId,
        });
      } else {
        emitToTenant(event.tenantId, 'conversation_updated', {
          conversationId: event.conversationId,
          mailId: event.mailId,
          accountId: event.accountId,
        });
      }
    });
    console.log('✓ Inbox realtime Redis bridge ready');

    console.log('✓ Queue producers ready (workers run in separate process)');
    logger.info('Server initialized successfully');

    httpServer.listen(PORT, () => {
      console.log(`✓ Server running on port ${PORT}`);
      console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`✓ IMAP IDLE: ${isImapIdleEnabled() ? 'enabled (worker)' : 'disabled'}`);
    });

    if (isImapIdleEnabled()) {
      // Primary inbound sync is IMAP IDLE inside MailCenterWorker.
      // Periodic reconciliation also runs inside ImapConnectionManager — no web IMAP cron.
      console.log(
        `✓ IMAP IDLE enabled — web mail-fetch cron disabled (reconcile every ${getImapReconcileIntervalMinutes()} min in worker)`
      );
    } else {
      // Dev/fallback: polling when IDLE is off
      cron.schedule(process.env.MAIL_FETCH_INTERVAL || '*/5 * * * *', async () => {
        console.log('Running mail fetch cron (IDLE disabled)...');
        const mailFetchService = new MailFetchService();
        await mailFetchService.fetchAllAccounts();
      });
    }

    cron.schedule('0 2 * * *', async () => {
      console.log('Running daily backup...');
      const backupService = new BackupService();
      await backupService.createBackup();
      await backupService.cleanOldBackups(7);
    });

    cron.schedule('*/30 * * * *', async () => {
      console.log('Refreshing expired OAuth tokens...');
      const oauthService = new OAuthService();
      await oauthService.refreshExpiredTokens();
    });
  } catch (error) {
    console.error('✗ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
