import { query } from '../config/database';
import { ImapService, isImapAuthError, safeImapErrorMessage } from './imapService';
import { AutoTagService } from './autoTagService';
import { FetchedMessage, MailAccount } from '../types';
import { emitToTenant } from './socketService';
import { trackUsage } from '../middleware/usageLimit';
import { updateStorageUsage, calculateMailSize } from '../middleware/storageQuota';
import webhookService from './webhookService';
import { migrateLegacyCredentials, withDecryptedCredentials } from '../utils/mailAccountUtils';
import { linkInboundEmailToConversation } from './conversationService';
import { publishInboxRealtime } from './redisEventBus';

export interface PersistResult {
  saved: boolean;
  mail?: any;
  conversationId?: number | null;
}

export class MailFetchService {
  private autoTagService: AutoTagService;

  constructor() {
    this.autoTagService = new AutoTagService();
  }

  async fetchAllAccounts(): Promise<void> {
    console.log('Starting reconciliation fetch for all active accounts...');

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
        await this.reconcileAccount(account);
      }

      console.log('✓ Reconciliation completed for all accounts');
    } catch (error) {
      console.error('✗ Error in fetchAllAccounts:', error);
    }
  }

  async fetchAccountById(accountId: number, tenantId?: number): Promise<void> {
    const result = tenantId
      ? await query(`SELECT * FROM mail_accounts WHERE id = $1 AND tenant_id = $2`, [
          accountId,
          tenantId,
        ])
      : await query(`SELECT * FROM mail_accounts WHERE id = $1`, [accountId]);

    if (result.rows.length === 0) {
      throw new Error('Mail account not found');
    }

    await this.reconcileAccount(result.rows[0] as MailAccount);
  }

  /**
   * Short-lived IMAP connect → fetch UIDs after last_sync_uid → disconnect.
   * Used for reconciliation and as fallback when IDLE is disabled.
   */
  async reconcileAccount(account: MailAccount): Promise<{ fetchedCount: number }> {
    if (!account.is_active) {
      return { fetchedCount: 0 };
    }

    const quota = await query(
      `SELECT 1 FROM tenants WHERE id = $1 AND storage_used_mb >= storage_limit_mb`,
      [account.tenant_id]
    );
    if (quota.rows.length > 0) {
      return { fetchedCount: 0 };
    }

    const imapService = new ImapService();
    const decryptedAccount = withDecryptedCredentials(account);

    try {
      await query(
        `UPDATE mail_accounts SET sync_status = 'syncing', sync_error = NULL WHERE id = $1 AND tenant_id = $2`,
        [account.id, account.tenant_id]
      );

      await imapService.connect(decryptedAccount);
      const lastUid = Number(account.last_sync_uid || 0);
      const storedValidity = account.imap_uidvalidity != null ? Number(account.imap_uidvalidity) : null;

      const { messages, meta, highestUid } = await imapService.fetchUidRange(account.id, lastUid);

      let uidValidityChanged = false;

      if (storedValidity && meta.uidValidity && storedValidity !== meta.uidValidity) {
        uidValidityChanged = true;
        console.warn(
          `UIDVALIDITY changed for account #${account.id}; rematching recent messages without full mailbox import`
        );
      }

      const toProcess =
        uidValidityChanged && lastUid > 0
          ? (await imapService.fetchUidRange(account.id, 0)).messages
          : messages;

      let fetchedCount = 0;
      let maxUid = uidValidityChanged ? 0 : lastUid;

      for (const message of toProcess) {
        if (!message.uid) continue;
        if (!uidValidityChanged && message.uid <= lastUid) continue;
        if (message.uid > maxUid) maxUid = message.uid;

        const result = await this.persistFetchedMessage(account, message);
        if (result.saved) fetchedCount++;
      }

      const finalHighest = Math.max(maxUid, highestUid, lastUid);

      await query(
        `UPDATE mail_accounts
         SET last_sync_uid = $1,
             imap_uidvalidity = $2,
             last_sync_at = CURRENT_TIMESTAMP,
             sync_status = 'idle',
             sync_error = NULL
         WHERE id = $3 AND tenant_id = $4`,
        [finalHighest, meta.uidValidity || storedValidity, account.id, account.tenant_id]
      );

      if (account.tenant_id) {
        await migrateLegacyCredentials(account.id, account.tenant_id);
      }

      console.log(`✓ Reconciled ${fetchedCount} message(s) for account #${account.id}`);
      return { fetchedCount };
    } catch (error: unknown) {
      const safe = safeImapErrorMessage(error);
      const status = isImapAuthError(error) ? 'error' : 'error';
      console.error(`✗ Reconciliation failed for account #${account.id}:`, safe);
      await query(
        `UPDATE mail_accounts
         SET sync_status = $1, sync_error = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3 AND tenant_id = $4`,
        [status, safe, account.id, account.tenant_id]
      );
      throw error;
    } finally {
      await imapService.disconnect();
    }
  }

  /**
   * Persist messages already fetched on an open IDLE connection (no reconnect).
   */
  async persistFetchedMessages(
    account: MailAccount,
    messages: FetchedMessage[],
    meta?: { uidValidity?: number }
  ): Promise<{ fetchedCount: number; maxUid: number }> {
    let fetchedCount = 0;
    let maxUid = Number(account.last_sync_uid || 0);

    for (const message of messages) {
      if (!message.uid) continue;
      if (message.uid > maxUid) maxUid = message.uid;
      const result = await this.persistFetchedMessage(account, message);
      if (result.saved) fetchedCount++;
    }

    await query(
      `UPDATE mail_accounts
       SET last_sync_uid = GREATEST(COALESCE(last_sync_uid, 0), $1),
           imap_uidvalidity = COALESCE($2, imap_uidvalidity),
           last_sync_at = CURRENT_TIMESTAMP,
           sync_status = 'idle',
           sync_error = NULL
       WHERE id = $3 AND tenant_id = $4`,
      [maxUid, meta?.uidValidity ?? null, account.id, account.tenant_id]
    );

    return { fetchedCount, maxUid };
  }

  async persistFetchedMessage(account: MailAccount, msg: FetchedMessage): Promise<PersistResult> {
    const tenantId = account.tenant_id!;
    const messageId = msg.messageId;
    const uid = msg.uid ?? null;

    try {
      if (uid != null) {
        const byUid = await query(
          `SELECT id FROM mails WHERE account_id = $1 AND imap_uid = $2`,
          [account.id, uid]
        );
        if (byUid.rows.length > 0) {
          return { saved: false };
        }
      }

      const byMsg = await query(
        `SELECT id FROM mails WHERE message_id = $1 AND account_id = $2`,
        [messageId, account.id]
      );
      if (byMsg.rows.length > 0) {
        if (uid != null) {
          await query(`UPDATE mails SET imap_uid = COALESCE(imap_uid, $1) WHERE id = $2`, [
            uid,
            byMsg.rows[0].id,
          ]);
        }
        return { saved: false };
      }

      const result = await query(
        `INSERT INTO mails (
          account_id, message_id, subject, from_address, to_address,
          date, body_preview, raw_headers, tenant_id, in_reply_to, mail_references, imap_uid
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (message_id) DO NOTHING
        RETURNING *`,
        [
          account.id,
          messageId,
          msg.subject,
          msg.from,
          msg.to,
          msg.date,
          msg.bodyPreview,
          JSON.stringify(msg.headers),
          tenantId,
          msg.inReplyTo || null,
          msg.references || null,
          uid,
        ]
      );

      if (result.rows.length === 0) {
        return { saved: false };
      }

      const mail = result.rows[0];

      await this.autoTagService.autoTagMail(
        mail.id,
        msg.subject || '',
        msg.bodyPreview || '',
        tenantId
      );

      let conversationId: number | null = null;
      try {
        conversationId = await linkInboundEmailToConversation({
          tenantId,
          mailId: mail.id,
          accountId: account.id,
          messageId,
          inReplyTo: msg.inReplyTo || null,
          referencesHeader: msg.references || null,
          fromAddress: msg.from,
          subject: msg.subject || null,
          receivedAt: msg.date ? new Date(msg.date) : new Date(),
        });
      } catch (linkErr) {
        console.error('Error linking mail to conversation:', linkErr);
      }

      await query(
        `UPDATE mail_accounts SET last_inbound_at = CURRENT_TIMESTAMP WHERE id = $1 AND tenant_id = $2`,
        [account.id, tenantId]
      );

      const mailSize = calculateMailSize(mail);
      const mailSizeMB = mailSize / (1024 * 1024);
      await updateStorageUsage(tenantId, mailSizeMB);

      emitToTenant(tenantId, 'new_mail', {
        id: mail.id,
        subject: mail.subject,
        from: mail.from_address,
        accountId: account.id,
        conversationId,
      });

      emitToTenant(tenantId, 'conversation_updated', {
        conversationId,
        mailId: mail.id,
        accountId: account.id,
      });

      await publishInboxRealtime({
        type: 'new_mail',
        tenantId,
        conversationId: conversationId ?? undefined,
        mailId: mail.id,
        accountId: account.id,
        subject: mail.subject,
        from: mail.from_address,
      });

      await trackUsage(tenantId, null, 'mail_fetch', 'mail', mail.id);

      await webhookService.triggerWebhook(tenantId, 'mail.received', {
        mailId: mail.id,
        subject: mail.subject,
        from: mail.from_address,
        accountId: account.id,
      });

      try {
        const { applyAutomationRules } = await import('./automationEngine');
        await applyAutomationRules(mail.id, tenantId);
      } catch (autoErr) {
        console.error('Automation emit error:', autoErr);
      }

      return { saved: true, mail, conversationId };
    } catch (error) {
      console.error('Error saving mail:', error);
      return { saved: false };
    }
  }
}
