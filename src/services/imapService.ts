import { ImapFlow } from 'imapflow';
import { MailAccount, FetchedMessage } from '../types';

export class ImapService {
  private client: ImapFlow | null = null;

  async connect(account: MailAccount): Promise<void> {
    try {
      this.client = new ImapFlow({
        host: account.imap_host,
        port: account.imap_port,
        secure: true,
        auth: {
          user: account.imap_user,
          pass: account.imap_password,
        },
        logger: false,
      });

      await this.client.connect();
      console.log(`✓ Connected to ${account.email}`);
    } catch (error) {
      console.error(`✗ Failed to connect to ${account.email}:`, error);
      throw error;
    }
  }

  async fetchRecentMails(limit: number = 50): Promise<FetchedMessage[]> {
    if (!this.client) {
      throw new Error('IMAP client not connected');
    }

    try {
      const lock = await this.client.getMailboxLock('INBOX');
      const messages: FetchedMessage[] = [];

      try {
        const mailboxStatus = await this.client.status('INBOX', { messages: true });
        const totalMessages = mailboxStatus.messages;
        
        if (!totalMessages || totalMessages === 0) {
          return messages;
        }

        const startSeq = Math.max(1, totalMessages - limit + 1);
        const endSeq = totalMessages;

        for await (const msg of this.client.fetch(`${startSeq}:${endSeq}`, {
          envelope: true,
          bodyStructure: true,
          source: false,
        })) {
          const envelope = msg.envelope;
          
          if (!envelope) continue;
          
          const bodyPreview = await this.getBodyPreview(msg.uid);

          messages.push({
            messageId: envelope.messageId || `${msg.uid}-${Date.now()}`,
            subject: envelope.subject || '(No Subject)',
            from: envelope.from?.[0]?.address || 'unknown',
            to: envelope.to?.map(t => t.address).join(', ') || '',
            date: envelope.date || new Date(),
            bodyPreview: bodyPreview,
            headers: envelope,
          });
        }
      } finally {
        lock.release();
      }

      return messages.reverse();
    } catch (error) {
      console.error('Error fetching mails:', error);
      throw error;
    }
  }

  private async getBodyPreview(uid: number): Promise<string> {
    if (!this.client) return '';

    try {
      const { content } = await this.client.download(String(uid), '1', {
        maxBytes: 500,
      });

      let text = '';
      for await (const chunk of content) {
        text += chunk.toString();
      }

      return text
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 200);
    } catch (error) {
      return '';
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.logout();
      this.client = null;
      console.log('✓ Disconnected from IMAP');
    }
  }
}
