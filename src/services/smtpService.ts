import nodemailer, { Transporter } from 'nodemailer';
import { MailAccount, SendMailRequest, SendMailResponse } from '../types';
import { query } from '../config/database';

export class SmtpService {
  private createTransporter(account: MailAccount): Transporter {
    if (!account.smtp_host || !account.smtp_user || !account.smtp_password) {
      throw new Error('SMTP configuration is incomplete for this account');
    }

    return nodemailer.createTransport({
      host: account.smtp_host,
      port: account.smtp_port || 587,
      secure: account.smtp_secure || false,
      auth: {
        user: account.smtp_user,
        pass: account.smtp_password,
      },
    });
  }

  async sendMail(request: SendMailRequest, tenantId: number): Promise<SendMailResponse> {
    try {
      const accountResult = await query(
        'SELECT * FROM mail_accounts WHERE id = $1 AND tenant_id = $2 AND is_active = true',
        [request.accountId, tenantId]
      );

      if (accountResult.rows.length === 0) {
        return {
          success: false,
          error: 'Account not found or inactive',
        };
      }

      const account: MailAccount = accountResult.rows[0];

      if (!account.smtp_host || !account.smtp_user || !account.smtp_password) {
        return {
          success: false,
          error: 'SMTP is not configured for this account',
        };
      }

      const transporter = this.createTransporter(account);

      const mailOptions = {
        from: `${account.name} <${account.email}>`,
        to: request.to,
        subject: request.subject,
        text: request.text,
        html: request.html,
      };

      const info = await transporter.sendMail(mailOptions);

      await this.saveSentMail(account.id, request, info.messageId, tenantId);

      console.log(`✓ Mail sent successfully: ${info.messageId}`);

      return {
        success: true,
        messageId: info.messageId,
      };
    } catch (error: any) {
      console.error('✗ Error sending mail:', error);
      return {
        success: false,
        error: error.message || 'Failed to send mail',
      };
    }
  }

  private async saveSentMail(
    accountId: number,
    request: SendMailRequest,
    messageId: string,
    tenantId: number
  ): Promise<void> {
    try {
      const bodyPreview = request.text
        ? request.text.substring(0, 200)
        : request.html
        ? request.html.replace(/<[^>]*>/g, '').substring(0, 200)
        : '';

      await query(
        `INSERT INTO mails (
          account_id, message_id, subject, from_address, to_address, 
          date, body_preview, is_sent, is_read, tenant_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          accountId,
          messageId,
          request.subject,
          (await this.getAccountEmail(accountId)) || 'unknown',
          request.to,
          new Date(),
          bodyPreview,
          true,
          true,
          tenantId,
        ]
      );

      console.log(`✓ Sent mail saved to database: ${messageId}`);
    } catch (error) {
      console.error('✗ Error saving sent mail to database:', error);
    }
  }

  private async getAccountEmail(accountId: number): Promise<string | null> {
    try {
      const result = await query('SELECT email FROM mail_accounts WHERE id = $1', [
        accountId,
      ]);
      return result.rows[0]?.email || null;
    } catch (error) {
      return null;
    }
  }

  async verifySmtpConfig(account: MailAccount): Promise<boolean> {
    try {
      const transporter = this.createTransporter(account);
      await transporter.verify();
      console.log(`✓ SMTP configuration verified for ${account.email}`);
      return true;
    } catch (error) {
      console.error(`✗ SMTP verification failed for ${account.email}:`, error);
      return false;
    }
  }
}
