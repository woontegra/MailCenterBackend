import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import webhookService from '../services/webhookService';

const router = Router();

router.use(authenticate);

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const webhooks = await webhookService.listWebhooks(tenantId);
    res.json({ webhooks });
  } catch (error: any) {
    console.error('List webhooks error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { url, events } = req.body;

    if (!url || !events || !Array.isArray(events)) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    const webhook = await webhookService.createWebhook(tenantId, url, events);
    res.status(201).json({ webhook });
  } catch (error: any) {
    console.error('Create webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { id } = req.params;

    await webhookService.deleteWebhook(parseInt(id), tenantId);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Delete webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
