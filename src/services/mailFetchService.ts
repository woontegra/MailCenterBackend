import { query } from '../config/database';
import { ImapService } from './imapService';
import { AutoTagService } from './autoTagService';
import { MailAccount } from '../types';

export class MailFetchService {
  private autoTagService: AutoTagService;

  constructor() {
    this.autoTagService = new AutoTagService();
  }

  async fetchAllAccounts(): Promise<void> {
    console.log('Starting mail fetch for all accounts...');

    try {
      const result = await query(
        'SELECT * FROM mail_accounts WHERE is_active = true'
      );

      const accounts: MailAccount[] = result.rows;

      if (accounts.length === 0) {
        console.log('No active accounts found');
        return;
      }

      for (const account of accounts) {
        await this.fetchAccountMails(account);
      }

      console.log('✓ Mail fetch completed for all accounts');
    } catch (error) {
      console.error('✗ Error in fetchAllAccounts:', error);
    }
  }

  private async fetchAccountMails(account: MailAccount): Promise<void> {
    const imapService = new ImapService();

    try {
      console.log(`Fetching mails for ${account.email}...`);

      await imapService.connect(account);
      const messages = await imapService.fetchRecentMails(50);

      console.log(`Found ${messages.length} messages for ${account.email}`);

      for (const msg of messages) {
        await this.saveMail(account.id, account.tenant_id!, msg);
      }

      console.log(`✓ Saved mails for ${account.email}`);
    } catch (error) {
      console.error(`✗ Error fetching mails for ${account.email}:`, error);
    } finally {
      await imapService.disconnect();
    }
  }

  private async saveMail(accountId: number, tenantId: number, msg: any): Promise<void> {
    try {
      const result = await query(
        `INSERT INTO mails (
          account_id, message_id, subject, from_address, to_address, 
          date, body_preview, raw_headers, tenant_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (message_id) DO NOTHING
        RETURNING id`,
        [
          accountId,
          msg.messageId,
          msg.subject,
          msg.from,
          msg.to,
          msg.date,
          msg.bodyPreview,
          JSON.stringify(msg.headers),
          tenantId,
        ]
      );

      if (result.rows.length > 0) {
        const mailId = result.rows[0].id;
        await this.autoTagService.autoTagMail(
          mailId,
          msg.subject || '',
          msg.bodyPreview || '',
          tenantId
        );
      }
    } catch (error) {
      console.error('Error saving mail:', error);
    }
  }
}
