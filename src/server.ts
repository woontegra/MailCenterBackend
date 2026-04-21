import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from './config/database';
import { startMailCron } from './cron/mailCron';

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
import { apiRateLimit } from './middleware/rateLimit';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(apiRateLimit());

app.use('/api/auth', authRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/mails', mailRoutes);
app.use('/api/tags', tagRoutes);
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

const startServer = async () => {
  try {
    await pool.query('SELECT NOW()');
    console.log('✓ Database connected');

    startMailCron();

    app.listen(PORT, () => {
      console.log(`✓ Server running on port ${PORT}`);
      console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    console.error('✗ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
