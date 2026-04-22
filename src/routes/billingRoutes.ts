import { Router, Response } from 'express';
import Stripe from 'stripe';
import { authenticate, AuthRequest } from '../middleware/auth';
import { query } from '../config/database';

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2024-11-20.acacia',
});

router.use(authenticate);

router.post('/checkout', async (req: AuthRequest, res: Response) => {
  try {
    const { planId, billingPeriod } = req.body;
    const tenantId = req.user!.tenantId;

    const planResult = await query('SELECT * FROM plans WHERE id = $1', [planId]);
    if (planResult.rows.length === 0) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    const plan = planResult.rows[0];
    const price = billingPeriod === 'yearly' ? plan.price_yearly : plan.price_monthly;

    const tenantResult = await query('SELECT * FROM tenants WHERE id = $1', [tenantId]);
    const tenant = tenantResult.rows[0];

    let customerId = null;
    const subResult = await query(
      'SELECT stripe_customer_id FROM subscriptions WHERE tenant_id = $1 LIMIT 1',
      [tenantId]
    );
    
    if (subResult.rows.length > 0 && subResult.rows[0].stripe_customer_id) {
      customerId = subResult.rows[0].stripe_customer_id;
    } else {
      const customer = await stripe.customers.create({
        email: req.user!.email,
        metadata: { tenantId: tenantId.toString(), tenantName: tenant.name }
      });
      customerId = customer.id;
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: plan.display_name,
            description: `${plan.display_name} Plan - ${billingPeriod}`,
          },
          unit_amount: Math.round(price * 100),
          recurring: {
            interval: billingPeriod === 'yearly' ? 'year' : 'month',
          },
        },
        quantity: 1,
      }],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/billing/cancel`,
      metadata: {
        tenantId: tenantId.toString(),
        planId: planId.toString(),
      },
    });

    res.json({ sessionId: session.id, url: session.url });
  } catch (error: any) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'] as string;

  try {
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET || ''
    );

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const tenantId = parseInt(session.metadata?.tenantId || '0');
        const planId = parseInt(session.metadata?.planId || '0');

        if (session.subscription) {
          const subscription = await stripe.subscriptions.retrieve(session.subscription as string);
          
          await query(
            `INSERT INTO subscriptions 
             (tenant_id, plan_id, stripe_subscription_id, stripe_customer_id, status, 
              current_period_start, current_period_end)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (stripe_subscription_id) 
             DO UPDATE SET status = $5, current_period_start = $6, current_period_end = $7`,
            [
              tenantId,
              planId,
              subscription.id,
              subscription.customer,
              subscription.status,
              new Date(subscription.current_period_start * 1000),
              new Date(subscription.current_period_end * 1000),
            ]
          );

          await query(
            'UPDATE tenants SET subscription_plan = $1, is_active = true WHERE id = $2',
            [(await query('SELECT name FROM plans WHERE id = $1', [planId])).rows[0].name, tenantId]
          );
        }
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        
        await query(
          `UPDATE subscriptions 
           SET status = $1, current_period_start = $2, current_period_end = $3, updated_at = CURRENT_TIMESTAMP
           WHERE stripe_subscription_id = $4`,
          [
            subscription.status,
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
            await query(
              'UPDATE tenants SET is_active = false WHERE id = $1',
              [subResult.rows[0].tenant_id]
            );
          }
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
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
  } catch (error: any) {
    console.error('Webhook error:', error);
    res.status(400).send(`Webhook Error: ${error.message}`);
  }
});

router.get('/subscription', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;

    const result = await query(
      `SELECT s.*, p.name as plan_name, p.display_name, p.max_accounts, p.max_users, p.max_daily_fetch
       FROM subscriptions s
       JOIN plans p ON s.plan_id = p.id
       WHERE s.tenant_id = $1
       ORDER BY s.created_at DESC LIMIT 1`,
      [tenantId]
    );

    if (result.rows.length === 0) {
      return res.json({ subscription: null });
    }

    res.json({ subscription: result.rows[0] });
  } catch (error: any) {
    console.error('Get subscription error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/usage', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const result = await query(
      'SELECT * FROM usage_limits WHERE tenant_id = $1 AND period_start = $2',
      [tenantId, periodStart]
    );

    res.json({ usage: result.rows[0] || null });
  } catch (error: any) {
    console.error('Get usage error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/cancel', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;

    const subResult = await query(
      'SELECT stripe_subscription_id FROM subscriptions WHERE tenant_id = $1 AND status = $2 LIMIT 1',
      [tenantId, 'active']
    );

    if (subResult.rows.length === 0) {
      return res.status(404).json({ error: 'No active subscription' });
    }

    const stripeSubId = subResult.rows[0].stripe_subscription_id;
    await stripe.subscriptions.update(stripeSubId, { cancel_at_period_end: true });

    await query(
      'UPDATE subscriptions SET cancel_at_period_end = true WHERE stripe_subscription_id = $1',
      [stripeSubId]
    );

    res.json({ success: true });
  } catch (error: any) {
    console.error('Cancel subscription error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
