import nodemailer, { Transporter } from 'nodemailer';
import { query } from '../config/database';
import { MailAccount, SendMailRequest, SendMailResponse } from '../types';
import { migrateLegacyCredentials, withDecryptedCredentials } from '../utils/mailAccountUtils';

export class SmtpService {
  private createTransporter(account: MailAccount, options?: any): Transporter {
    if (!account.smtp_host || !account.smtp_user) {
      throw new Error('SMTP configuration is incomplete for this account');
    }

    const config: any = {
      host: account.smtp_host,
      port: account.smtp_port || 587,
      secure: account.smtp_secure || false,
    };

    if (account.auth_type === 'oauth' && account.access_token) {
      config.auth = {
        type: 'OAuth2',
        user: account.smtp_user,
        accessToken: account.access_token,
      };
    } else if (account.smtp_password) {
      config.auth = {
        user: account.smtp_user,
        pass: account.smtp_password,
      };
    } else {
      throw new Error('No authentication method available');
    }

    if (options) {
      Object.assign(config, options);
    }

    return nodemailer.createTransport(config);
  }

  async sendMail(request: SendMailRequest, tenantId: number, options?: any): Promise<SendMailResponse> {
    try {
      const accountResult = await query(
        'SELECT * FROM mail_accounts WHERE id = $1 AND tenant_id = $2 AND is_active = true',
        [request.accountId, tenantId]
      );

      if (accountResult.rows.length === 0) {
        throw new Error('Mail account not found or inactive');
      }

      const account: MailAccount = withDecryptedCredentials(accountResult.rows[0]);

      if (!account.smtp_host || !account.smtp_user || !account.smtp_password) {
        return {
          success: false,
          error: 'SMTP is not configured for this account',
        };
      }

      const transporter = this.createTransporter(account);

      const fromEmail = request.fromEmail || account.email;
      const fromName = request.fromName || account.name;

      const mailOptions: Record<string, unknown> = {
        from: `${fromName} <${fromEmail}>`,
        to: request.to,
        subject: request.subject,
        text: request.text,
        html: request.html,
      };

      if (request.cc) mailOptions.cc = request.cc;
      if (request.bcc) mailOptions.bcc = request.bcc;
      if (request.replyTo) mailOptions.replyTo = request.replyTo;

      const info = await transporter.sendMail(mailOptions);

      await this.saveSentMail(account.id, request, info.messageId, tenantId, fromEmail);

      await migrateLegacyCredentials(account.id, tenantId);

      console.log(`✓ Mail sent successfully: ${info.messageId}`);

      return {
        success: true,
        messageId: info.messageId,
      };
    } catch (error: any) {
      console.error('✗ Error sending mail:', error.message || 'Failed to send mail');
      return {
        success: false,
        error: 'Failed to send mail',
      };
    }
  }

  private async saveSentMail(
    accountId: number,
    request: SendMailRequest,
    messageId: string,
    tenantId: number,
    fromEmail?: string
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
          fromEmail || (await this.getAccountEmail(accountId)) || 'unknown',
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
      console.error('✗ Error saving sent mail to database');
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
