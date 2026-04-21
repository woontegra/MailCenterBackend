import cron from 'node-cron';
import { MailFetchService } from '../services/mailFetchService';
import dotenv from 'dotenv';

dotenv.config();

const mailFetchService = new MailFetchService();

export const startMailCron = () => {
  const cronExpression = process.env.MAIL_FETCH_INTERVAL || '*/5 * * * *';

  cron.schedule(cronExpression, async () => {
    console.log(`[${new Date().toISOString()}] Running mail fetch cron...`);
    await mailFetchService.fetchAllAccounts();
  });

  console.log(`✓ Mail fetch cron started with schedule: ${cronExpression}`);
};
