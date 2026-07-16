import { Router, Request, Response } from 'express';
import { MetaWhatsAppCloudAdapter } from '../whatsapp/providers/metaWhatsAppCloudAdapter';
import { unpackWhatsAppCredentials } from '../whatsapp/whatsappCredentials';
import {
  findWhatsAppConnectionByPhoneNumberId,
  findWhatsAppConnectionsByVerifyToken,
  processMetaWhatsAppWebhookEvents,
} from '../services/whatsappWebhookService';

const router = Router();
const adapter = new MetaWhatsAppCloudAdapter();

/**
 * Meta webhook verification (GET)
 * Official: hub.mode=subscribe, hub.verify_token, hub.challenge
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const mode = String(req.query['hub.mode'] || '');
    const token = String(req.query['hub.verify_token'] || '');
    const challenge = String(req.query['hub.challenge'] || '');

    if (!token) {
      return res.status(403).send('Forbidden');
    }

    const matches = await findWhatsAppConnectionsByVerifyToken(token);
    if (matches.length === 0) {
      return res.status(403).send('Forbidden');
    }

    const verified = adapter.verifyWebhook({
      mode,
      challenge,
      verifyToken: token,
      expectedVerifyToken: token,
    });

    if (!verified.ok || verified.challenge == null) {
      return res.status(403).send('Forbidden');
    }

    return res.status(200).send(verified.challenge);
  } catch (error) {
    console.error('WhatsApp webhook verify error');
    return res.status(403).send('Forbidden');
  }
});

/**
 * Meta webhook events (POST)
 * Requires valid X-Hub-Signature-256; invalid signatures change nothing.
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const rawBody: Buffer =
      (req as any).rawBody instanceof Buffer
        ? (req as any).rawBody
        : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));

    let payload: any;
    try {
      payload =
        typeof req.body === 'object' && req.body && !Buffer.isBuffer(req.body)
          ? req.body
          : JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    const events = adapter.parseWebhook(payload);
    if (events.length === 0) {
      // Always 200 to Meta for unrecognized but well-formed payloads
      return res.status(200).json({ success: true, processed: 0 });
    }

    const phoneNumberIds = Array.from(new Set(events.map((e) => e.phoneNumberId)));
    let total = 0;

    for (const phoneNumberId of phoneNumberIds) {
      const connections = await findWhatsAppConnectionByPhoneNumberId(phoneNumberId);
      if (connections.length === 0) continue;

      // Signature must validate against at least one matching connection's app secret
      let signatureOk = false;
      for (const connection of connections) {
        try {
          const creds = unpackWhatsAppCredentials(connection.encrypted_credentials);
          if (
            adapter.validateWebhookSignature({
              appSecret: creds.appSecret,
              rawBody,
              signatureHeader: req.header('X-Hub-Signature-256') || req.header('x-hub-signature-256'),
            })
          ) {
            signatureOk = true;
            break;
          }
        } catch {
          /* skip */
        }
      }

      if (!signatureOk) {
        console.error('WhatsApp webhook rejected: invalid signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }

      const result = await processMetaWhatsAppWebhookEvents({
        phoneNumberId,
        events: events.filter((e) => e.phoneNumberId === phoneNumberId),
      });
      total += result.processed;
    }

    return res.status(200).json({ success: true, processed: total });
  } catch (error) {
    console.error('WhatsApp webhook processing error');
    // Return 200 to avoid aggressive Meta retries on our bugs for already-parsed payloads?
    // Prefer 500 so Meta retries transient failures.
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;
