import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { authenticate, AuthRequest } from '../middleware/auth';
import { query } from '../config/database';

const router = Router();

let stripe: InstanceType<typeof Stripe> | null = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-11-20.acacia' as any,
  });
}

/** Map Stripe subscription statuses to the DB CHECK enum (uppercase). */
function mapStripeStatus(stripeStatus: string): string {
  switch (String(stripeStatus || '').toLowerCase()) {
    case 'trialing':
      return 'TRIAL';
    case 'active':
      return 'ACTIVE';
    case 'past_due':
      return 'PAST_DUE';
    case 'canceled':
    case 'cancelled':
      return 'CANCELLED';
    case 'unpaid':
    case 'paused':
      return 'SUSPENDED';
    case 'incomplete':
    case 'incomplete_expired':
      return 'EXPIRED';
    default:
      return 'ACTIVE';
  }
}

/**
 * Stripe webhook must stay unauthenticated.
 * Checkout/cancel are intentionally disabled until Price IDs + frontend
 * success pages are completed — do not present as a live purchase flow.
 */
router.post('/webhook', async (req: Request, res: Response): Promise<void> => {
  const sig = req.headers['stripe-signature'] as string;

  if (!sig) {
    res.status(400).json({ error: 'Missing signature' });
    return;
  }

  if (!stripe) {
    res.status(503).json({ error: 'Stripe is not configured' });
    return;
  }

  try {
    const payload = (req as any).rawBody || req.body;
    const event = stripe.webhooks.constructEvent(
      payload,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET || ''
    );

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as any;
        const tenantId = parseInt(session.metadata?.tenantId || '0');
        const planId = parseInt(session.metadata?.planId || '0');

        if (session.subscription) {
          const subscription: any = await stripe.subscriptions.retrieve(
            session.subscription as string
          );

          await query(
            `INSERT INTO subscriptions 
             (tenant_id, plan_id, stripe_subscription_id, stripe_customer_id, status, 
              current_period_start, current_period_end, provider, provider_subscription_id, provider_customer_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'stripe', $3, $4)
             ON CONFLICT (stripe_subscription_id) 
             DO UPDATE SET status = $5, current_period_start = $6, current_period_end = $7`,
            [
              tenantId,
              planId,
              subscription.id,
              subscription.customer,
              mapStripeStatus(subscription.status),
              new Date((subscription.current_period_start || 0) * 1000),
              new Date((subscription.current_period_end || 0) * 1000),
            ]
          );

          await query(
            'UPDATE tenants SET subscription_plan = $1, is_active = true WHERE id = $2',
            [
              (await query('SELECT name FROM plans WHERE id = $1', [planId])).rows[0]?.name,
              tenantId,
            ]
          );
        }
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subscription: any = event.data.object;

        await query(
          `UPDATE subscriptions 
           SET status = $1, current_period_start = $2, current_period_end = $3, updated_at = CURRENT_TIMESTAMP
           WHERE stripe_subscription_id = $4`,
          [
            mapStripeStatus(subscription.status),
            new Date(subscription.current_period_start * 1000),
            new Date(subscription.current_period_end * 1000),
            subscription.id,
          ]
        );

        if (subscription.status === 'canceled' || subscription.status === 'unpaid') {
          const subResult = await query(
            'SELECT tenant_id FROM subscriptions WHERE stripe_subscription_id = $1',
            [subscription.id]
          );
          if (subResult.rows.length > 0) {
            await query('UPDATE tenants SET is_active = false, status = $2 WHERE id = $1', [
              subResult.rows[0].tenant_id,
              'SUSPENDED',
            ]);
          }
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice: any = event.data.object;
        const subResult = await query(
          'SELECT id, tenant_id FROM subscriptions WHERE stripe_subscription_id = $1',
          [invoice.subscription]
        );

        if (subResult.rows.length > 0) {
          await query(
            `INSERT INTO payment_transactions 
             (tenant_id, subscription_id, stripe_payment_id, amount, currency, status, payment_method)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              subResult.rows[0].tenant_id,
              subResult.rows[0].id,
              invoice.payment_intent,
              invoice.amount_paid / 100,
              invoice.currency,
              'succeeded',
              'card',
            ]
          );
        }
        break;
      }
    }

    res.json({ received: true });
    return;
  } catch (error: any) {
    console.error('Webhook error:', error);
    res.status(400).send(`Webhook Error: ${error.message}`);
    return;
  }
});

router.use(authenticate);

router.post('/checkout', async (_req: AuthRequest, res: Response) => {
  return res.status(503).json({
    success: false,
    code: 'BILLING_NOT_CONFIGURED',
    error: 'Online satın alma henüz etkin değil. Plan değişikliği için iletişime geçin.',
    contactRequired: true,
  });
});

router.get('/subscription', async (req: AuthRequest, res: Response) => {
  try {
    const {
      getTenantEntitlements,
      sanitizeEntitlementsSummary,
      recalculateCountUsage,
    } = await import('../services/entitlementService');
    await recalculateCountUsage(req.user!.tenantId).catch(() => null);
    const { reconcileSendUsage } = await import('../services/entitlementService');
    await reconcileSendUsage(req.user!.tenantId).catch(() => null);
    const ent = sanitizeEntitlementsSummary(await getTenantEntitlements(req.user!.tenantId));
    res.json({ success: true, data: ent, subscription: ent });
  } catch (error: any) {
    const { respondEntitlementError } = await import('../services/entitlementService');
    if (respondEntitlementError(res, error)) return;
    console.error('Get subscription error:', error);
    res.status(500).json({ error: 'Abonelik bilgisi alınamadı' });
  }
});

router.get('/usage', async (req: AuthRequest, res: Response) => {
  try {
    const {
      getTenantEntitlements,
      sanitizeEntitlementsSummary,
      recalculateCountUsage,
    } = await import('../services/entitlementService');
    await recalculateCountUsage(req.user!.tenantId);
    const { reconcileSendUsage } = await import('../services/entitlementService');
    await reconcileSendUsage(req.user!.tenantId);
    const ent = sanitizeEntitlementsSummary(await getTenantEntitlements(req.user!.tenantId));
    res.json({ success: true, data: ent, usage: ent.usage });
  } catch (error: any) {
    const { respondEntitlementError } = await import('../services/entitlementService');
    if (respondEntitlementError(res, error)) return;
    console.error('Get usage error:', error);
    res.status(500).json({ error: 'Kullanım bilgisi alınamadı' });
  }
});

router.post('/cancel', async (_req: AuthRequest, res: Response) => {
  return res.status(503).json({
    success: false,
    code: 'BILLING_NOT_CONFIGURED',
    error: 'Online iptal henüz etkin değil. Plan değişikliği için iletişime geçin.',
    contactRequired: true,
  });
});

export default router;
