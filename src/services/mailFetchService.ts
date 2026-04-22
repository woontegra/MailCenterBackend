import { query } from '../config/database';
import { ImapService } from './imapService';
import { AutoTagService } from './autoTagService';
import { MailAccount } from '../types';
import { emitToTenant } from './socketService';
import { trackUsage } from '../middleware/usageLimit';
import { updateStorageUsage, calculateMailSize } from '../middleware/storageQuota';
import webhookService from './webhookService';

export class MailFetchService {
  private autoTagService: AutoTagService;

  constructor() {
    this.autoTagService = new AutoTagService();
  }

  async fetchAllAccounts(): Promise<void> {
    console.log('Starting mail fetch for all accounts...');
    
    const quotaCheck = await query(
      'SELECT id FROM tenants WHERE storage_used_mb >= storage_limit_mb'
    );
    const exceededTenants = new Set(quotaCheck.rows.map(r => r.id));

    try {
      const accountsResult = await query(
        `SELECT * FROM mail_accounts 
         WHERE is_active = true AND tenant_id NOT IN (
           SELECT id FROM tenants WHERE storage_used_mb >= storage_limit_mb
         )`
      );

      const accounts: MailAccount[] = accountsResult.rows;

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
      const lastUid = account.last_sync_uid || 0;
      const fetchRange = lastUid > 0 ? `${lastUid + 1}:*` : '1:*';
      
      console.log(`Fetching from UID ${lastUid + 1} for ${account.email}`);
      
      const messages = await imapService.fetchRecentMails(fetchRange);

      let fetchedCount = 0;
      let maxUid = lastUid;
      
      for (const message of messages) {
        try {
          const messageUid = message.uid;
          if (messageUid > maxUid) {
            maxUid = messageUid;
          }
          
          const messageId = message.envelope?.messageId || `${account.id}-${messageUid}`;
          const existsResult = await query(
            'SELECT id FROM mails WHERE message_id = $1 AND account_id = $2',
            [messageId, account.id]
          );
          
          if (existsResult.rows.length === 0) {
            if (exceededTenants.has(account.tenant_id!)) {
              console.log(`Skipping mail for tenant ${account.tenant_id} - quota exceeded`);
              continue;
            }
            
            const savedMail = await this.saveMail(account.id, account.tenant_id!, message);
            fetchedCount++;
            
            const mailSize = calculateMailSize(savedMail);
            const mailSizeMB = mailSize / (1024 * 1024);
            await updateStorageUsage(account.tenant_id!, mailSizeMB);
            
            emitToTenant(account.tenant_id!, 'new_mail', {
              id: savedMail.id,
              subject: savedMail.subject,
              from: savedMail.from_address,
              accountId: account.id,
            });
            
            await trackUsage(account.tenant_id!, null, 'mail_fetch', 'mail', savedMail.id);
            
            await webhookService.triggerWebhook(account.tenant_id!, 'mail.received', {
              mailId: savedMail.id,
              subject: savedMail.subject,
              from: savedMail.from_address,
              accountId: account.id,
            });
          }
        } catch (error) {
          console.error('Error saving message:', error);
        }
      }

      await query(
        'UPDATE mail_accounts SET last_sync_uid = $1, last_sync_at = CURRENT_TIMESTAMP, sync_status = $2, sync_error = NULL WHERE id = $3',
        [maxUid, 'idle', account.id]
      );

      console.log(`✓ Fetched ${fetchedCount} new messages for ${account.email}`);
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
