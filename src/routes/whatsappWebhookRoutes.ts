import { Router, Request, Response } from 'express';
import { MetaWhatsAppCloudAdapter } from '../whatsapp/providers/metaWhatsAppCloudAdapter';
import { unpackWhatsAppCredentials } from '../whatsapp/whatsappCredentials';
import {
  findWhatsAppConnectionByPhoneNumberId,
  findWhatsAppConnectionsByVerifyToken,
  processMetaWhatsAppWebhookEvents,
} from '../services/whatsappWebhookService';
import { getMetaAppSecret, getMetaWhatsAppWebhookVerifyToken } from '../config/metaWhatsAppConfig';

const router = Router();
const adapter = new MetaWhatsAppCloudAdapter();

/**
 * Meta webhook verification (GET)
 * Accepts platform-level META_WHATSAPP_WEBHOOK_VERIFY_TOKEN or per-connection tokens.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const mode = String(req.query['hub.mode'] || '');
    const token = String(req.query['hub.verify_token'] || '');
    const challenge = String(req.query['hub.challenge'] || '');

    if (!token) {
      return res.status(403).send('Forbidden');
    }

    const platformToken = getMetaWhatsAppWebhookVerifyToken();
    const platformOk = Boolean(platformToken && token === platformToken);

    let connectionOk = false;
    if (!platformOk) {
      const matches = await findWhatsAppConnectionsByVerifyToken(token);
      connectionOk = matches.length > 0;
    }

    if (!platformOk && !connectionOk) {
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
 * Signature: platform META_APP_SECRET first, then per-connection app_secret.
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

    if (payload?.object && payload.object !== 'whatsapp_business_account') {
      return res.status(200).json({ success: true, processed: 0 });
    }

    const signatureHeader =
      req.header('X-Hub-Signature-256') || req.header('x-hub-signature-256');

    const platformSecret = getMetaAppSecret();
    let signatureOk = false;
    if (platformSecret) {
      signatureOk = adapter.validateWebhookSignature({
        appSecret: platformSecret,
        rawBody,
        signatureHeader,
      });
    }

    const events = adapter.parseWebhook(payload);
    if (events.length === 0) {
      return res.status(200).json({ success: true, processed: 0 });
    }

    const phoneNumberIds = Array.from(new Set(events.map((e) => e.phoneNumberId)));
    let total = 0;

    for (const phoneNumberId of phoneNumberIds) {
      const connections = await findWhatsAppConnectionByPhoneNumberId(phoneNumberId);
      if (connections.length === 0) {
        console.warn(
          JSON.stringify({
            event: 'whatsapp_webhook_unknown_phone',
            phoneNumberIdSuffix: String(phoneNumberId).slice(-4),
          })
        );
        continue;
      }

      if (!signatureOk) {
        for (const connection of connections) {
          try {
            const creds = unpackWhatsAppCredentials(connection.encrypted_credentials);
            if (
              adapter.validateWebhookSignature({
                appSecret: creds.appSecret,
                rawBody,
                signatureHeader,
              })
            ) {
              signatureOk = true;
              break;
            }
          } catch {
            /* skip */
          }
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
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;
