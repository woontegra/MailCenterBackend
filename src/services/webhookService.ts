import { query } from '../config/database';
import { logError, logInfo } from '../config/logger';
import crypto from 'crypto';

export class WebhookService {
  async triggerWebhook(tenantId: number, eventType: string, payload: any) {
    try {
      const webhooksResult = await query(
        'SELECT * FROM webhooks WHERE tenant_id = $1 AND is_active = true AND $2 = ANY(events)',
        [tenantId, eventType]
      );

      for (const webhook of webhooksResult.rows) {
        await this.sendWebhook(webhook, eventType, payload);
      }
    } catch (error: any) {
      logError(error, { tenantId, eventType });
    }
  }

  private async sendWebhook(webhook: any, eventType: string, payload: any) {
    const timestamp = Date.now();
    const signature = this.generateSignature(webhook.secret, timestamp, payload);

    try {
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
          'X-Webhook-Timestamp': timestamp.toString(),
          'X-Webhook-Event': eventType,
        },
        body: JSON.stringify(payload),
      });

      await query(
        `INSERT INTO webhook_logs (webhook_id, event_type, payload, response_status, response_body)
         VALUES ($1, $2, $3, $4, $5)`,
        [webhook.id, eventType, JSON.stringify(payload), response.status, await response.text()]
      );

      logInfo('Webhook sent successfully', { webhookId: webhook.id, eventType });
    } catch (error: any) {
      await query(
        `INSERT INTO webhook_logs (webhook_id, event_type, payload, error)
         VALUES ($1, $2, $3, $4)`,
        [webhook.id, eventType, JSON.stringify(payload), error.message]
      );

      logError(error, { webhookId: webhook.id, eventType });
    }
  }

  private generateSignature(secret: string, timestamp: number, payload: any): string {
    const data = `${timestamp}.${JSON.stringify(payload)}`;
    return crypto.createHmac('sha256', secret).update(data).digest('hex');
  }

  async createWebhook(tenantId: number, url: string, events: string[]) {
    const secret = crypto.randomBytes(32).toString('hex');
    
    const result = await query(
      `INSERT INTO webhooks (tenant_id, url, events, secret)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [tenantId, url, events, secret]
    );

    return result.rows[0];
  }

  async deleteWebhook(webhookId: number, tenantId: number) {
    await query(
      'DELETE FROM webhooks WHERE id = $1 AND tenant_id = $2',
      [webhookId, tenantId]
    );
  }

  async listWebhooks(tenantId: number) {
    const result = await query(
      'SELECT id, url, events, is_active, created_at FROM webhooks WHERE tenant_id = $1',
      [tenantId]
    );
    return result.rows;
  }
}

export default new WebhookService();
