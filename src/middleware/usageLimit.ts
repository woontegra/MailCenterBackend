import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';
import { query } from '../config/database';

export const checkUsageLimit = (resourceType: 'account' | 'user' | 'mail_fetch' | 'mail_send') => {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;

      const subscriptionResult = await query(
        `SELECT s.*, p.max_accounts, p.max_users, p.max_daily_fetch
         FROM subscriptions s
         JOIN plans p ON s.plan_id = p.id
         WHERE s.tenant_id = $1 AND s.status = 'active'
         ORDER BY s.created_at DESC LIMIT 1`,
        [tenantId]
      );

      if (subscriptionResult.rows.length === 0) {
        return res.status(403).json({ error: 'No active subscription' });
      }

      const subscription = subscriptionResult.rows[0];
      const now = new Date();
      const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

      const usageResult = await query(
        `SELECT * FROM usage_limits 
         WHERE tenant_id = $1 AND period_start = $2`,
        [tenantId, periodStart]
      );

      let usage = usageResult.rows[0];
      if (!usage) {
        const createResult = await query(
          `INSERT INTO usage_limits (tenant_id, period_start, period_end)
           VALUES ($1, $2, $3) RETURNING *`,
          [tenantId, periodStart, periodEnd]
        );
        usage = createResult.rows[0];
      }

      let exceeded = false;
      let message = '';

      switch (resourceType) {
        case 'account':
          if (usage.accounts_used >= subscription.max_accounts) {
            exceeded = true;
            message = `Account limit reached (${subscription.max_accounts})`;
          }
          break;
        case 'user':
          if (usage.users_used >= subscription.max_users) {
            exceeded = true;
            message = `User limit reached (${subscription.max_users})`;
          }
          break;
        case 'mail_fetch':
          if (usage.mails_fetched >= subscription.max_daily_fetch) {
            exceeded = true;
            message = `Daily fetch limit reached (${subscription.max_daily_fetch})`;
          }
          break;
        case 'mail_send':
          if (usage.mails_sent >= subscription.max_daily_fetch) {
            exceeded = true;
            message = `Daily send limit reached (${subscription.max_daily_fetch})`;
          }
          break;
      }

      if (exceeded) {
        return res.status(429).json({ error: message, upgrade_required: true });
      }

      next();
    } catch (error) {
      console.error('Usage limit check error:', error);
      next();
    }
  };
};

export const trackUsage = async (
  tenantId: number,
  userId: number | null,
  actionType: string,
  resourceType: string,
  resourceId?: number,
  quantity: number = 1
) => {
  try {
    await query(
      `INSERT INTO usage_logs (tenant_id, user_id, action_type, resource_type, resource_id, quantity)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, userId, actionType, resourceType, resourceId, quantity]
    );

    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const field = actionType === 'mail_fetch' ? 'mails_fetched' :
                  actionType === 'mail_send' ? 'mails_sent' :
                  actionType === 'account_create' ? 'accounts_used' :
                  actionType === 'user_create' ? 'users_used' : null;

    if (field) {
      await query(
        `UPDATE usage_limits 
         SET ${field} = ${field} + $1, updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $2 AND period_start = $3`,
        [quantity, tenantId, periodStart]
      );
    }
  } catch (error) {
    console.error('Track usage error:', error);
  }
};
