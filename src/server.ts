import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
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
import { mailFetchWorker, mailSendWorker } from './queues/mailQueue';
import logger from './config/logger';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 5000;

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
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}));
app.use('/api/auth', authLimiter);
app.use('/api', limiter);
app.use(express.json());
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));

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
import inviteRoutes from './routes/inviteRoutes';
import inboxGroupedRoutes from './routes/inboxGroupedRoutes';
import threadRoutes from './routes/threadRoutes';
import billingRoutes from './routes/billingRoutes';
import adminRoutes from './routes/adminRoutes';
import oauthRoutes from './routes/oauthRoutes';
import storageRoutes from './routes/storageRoutes';
import webhookRoutes from './routes/webhookRoutes';
import exportRoutes from './routes/exportRoutes';
import whiteLabelRoutes from './routes/whiteLabelRoutes';
import superAdminRoutes from './routes/superAdminRoutes';

app.use('/api/auth', authRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/mails', mailRoutes);
app.use('/api/threads', threadRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/oauth', oauthRoutes);
app.use('/api/storage', storageRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/white-label', whiteLabelRoutes);
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/send-mail', sendMailRoutes);
app.use('/api/auto-tag', autoTagRoutes);
app.use('/api/users', userRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/automation', automationRoutes);
app.use('/api/attachments', attachmentRoutes);
app.use('/api/drafts', draftRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/invites', inviteRoutes);
app.use('/api/inbox', inboxGroupedRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use(errorHandler);

const startServer = async () => {
  try {
    await pool.query('SELECT NOW()');
    console.log('✓ Database connected');

    initializeSocket(httpServer);
    console.log('✓ Socket.io initialized');

    console.log('✓ Queue workers started');
    logger.info('Server initialized successfully');

    httpServer.listen(PORT, () => {
      console.log(`✓ Server running on port ${PORT}`);
      console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
    });

    cron.schedule(process.env.MAIL_FETCH_INTERVAL || '*/5 * * * *', async () => {
      console.log('Running mail fetch cron...');
      const mailFetchService = new MailFetchService();
      await mailFetchService.fetchAllAccounts();
    });

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
