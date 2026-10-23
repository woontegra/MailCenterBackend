import { Router, Request, Response } from 'express';
import { MetaWhatsAppCloudAdapter } from '../whatsapp/providers/metaWhatsAppCloudAdapter';
import { unpackWhatsAppCredentials } from '../whatsapp/whatsappCredentials';
import { getMetaAppSecret, getMetaWhatsAppWebhookVerifyToken } from '../config/metaWhatsAppConfig';
import { WhatsAppParsedWebhookEvent } from '../whatsapp/WhatsAppProviderAdapter';
import {
  CoexistenceWebhookChange,
  collectWebhookRoutingIds,
  extractCoexistenceChanges,
} from '../whatsapp/coexistenceWebhook';

const adapter = new MetaWhatsAppCloudAdapter();

export type SignatureSource = 'PLATFORM' | 'CONNECTION';

export type WhatsAppWebhookRouteDeps = {
  getPlatformAppSecret: () => string;
  getPlatformVerifyToken: () => string;
  findConnectionsByVerifyToken: (token: string) => Promise<unknown[]>;
  findConnectionsForSignature: (ids: {
    phoneNumberIds: string[];
    wabaIds: string[];
  }) => Promise<Array<{ encrypted_credentials: string | null }>>;
  unpackAppSecret: (encrypted: string | null) => string | null;
  processMessageEvents: (params: {
    phoneNumberId: string;
    events: WhatsAppParsedWebhookEvent[];
  }) => Promise<{ processed: number }>;
  storeCoexistenceChanges: (
    changes: CoexistenceWebhookChange[],
    signatureSource: SignatureSource
  ) => Promise<{ stored: number; duplicates: number }>;
  scheduleCoexistenceDrain: () => void;
};

/**
 * Verify X-Hub-Signature-256 over the exact raw request bytes.
 * Platform app secret first; per-connection secrets only for connections referenced in the payload.
 */
export async function verifyWhatsAppWebhookSignature(
  params: { rawBody: Buffer; signatureHeader: string | null | undefined; payload: unknown },
  deps: Pick<WhatsAppWebhookRouteDeps, 'getPlatformAppSecret' | 'findConnectionsForSignature' | 'unpackAppSecret'>
): Promise<SignatureSource | null> {
  return (await checkWhatsAppWebhookSignature(params, deps)).source;
}

/** `secretsTried` = 0 means no platform secret and no known connection for the payload. */
export async function checkWhatsAppWebhookSignature(
  params: { rawBody: Buffer; signatureHeader: string | null | undefined; payload: unknown },
  deps: Pick<WhatsAppWebhookRouteDeps, 'getPlatformAppSecret' | 'findConnectionsForSignature' | 'unpackAppSecret'>
): Promise<{ source: SignatureSource | null; secretsTried: number }> {
  const platformSecret = deps.getPlatformAppSecret();
  const hasHeader = Boolean(params.signatureHeader && String(params.signatureHeader).startsWith('sha256='));
  let secretsTried = 0;

  if (platformSecret) {
    secretsTried += 1;
    if (
      hasHeader &&
      adapter.validateWebhookSignature({
        appSecret: platformSecret,
        rawBody: params.rawBody,
        signatureHeader: params.signatureHeader,
      })
    ) {
      return { source: 'PLATFORM', secretsTried };
    }
  }

  const ids = collectWebhookRoutingIds(params.payload);
  const candidates = await deps.findConnectionsForSignature(ids);
  const tried = new Set<string>();
  for (const connection of candidates) {
    const secret = deps.unpackAppSecret(connection.encrypted_credentials);
    if (!secret || tried.has(secret) || secret === platformSecret) continue;
    tried.add(secret);
    secretsTried += 1;
    if (
      hasHeader &&
      adapter.validateWebhookSignature({
        appSecret: secret,
        rawBody: params.rawBody,
        signatureHeader: params.signatureHeader,
      })
    ) {
      return { source: 'CONNECTION', secretsTried };
    }
  }
  return { source: null, secretsTried };
}

export function createWhatsAppWebhookRouter(deps: WhatsAppWebhookRouteDeps): Router {
  const router = Router();

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

      const platformToken = deps.getPlatformVerifyToken();
      const platformOk = Boolean(platformToken && token === platformToken);

      let connectionOk = false;
      if (!platformOk) {
        const matches = await deps.findConnectionsByVerifyToken(token);
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
   * Nothing is stored or processed before the raw-body signature is verified.
   */
  router.post('/', async (req: Request, res: Response) => {
    try {
      const rawBody: Buffer | undefined =
        (req as any).rawBody instanceof Buffer ? (req as any).rawBody : undefined;
      if (!rawBody || rawBody.length === 0) {
        return res.status(400).json({ error: 'Missing body' });
      }

      let payload: any;
      try {
        payload =
          req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)
            ? req.body
            : JSON.parse(rawBody.toString('utf8'));
      } catch {
        return res.status(400).json({ error: 'Invalid JSON' });
      }

      const signatureHeader =
        req.header('X-Hub-Signature-256') || req.header('x-hub-signature-256');
      const signature = await checkWhatsAppWebhookSignature({ rawBody, signatureHeader, payload }, deps);
      const signatureSource = signature.source;
      if (!signatureSource) {
        if (signature.secretsTried === 0) {
          // Same response production gave for numbers it does not know: acknowledge, never store or process.
          console.warn(JSON.stringify({ event: 'whatsapp_webhook_unverifiable_unknown_target' }));
          return res.status(200).json({ success: true, processed: 0 });
        }
        console.error('WhatsApp webhook rejected: invalid signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }

      if (payload?.object && payload.object !== 'whatsapp_business_account') {
        return res.status(200).json({ success: true, processed: 0 });
      }

      // Existing messages/statuses first (idempotent on retry), so a coexistence storage error
      // never blocks them; storage failure still returns 500 so Meta redelivers the event.
      const events = adapter.parseWebhook(payload);
      let total = 0;
      const phoneNumberIds = Array.from(new Set(events.map((e) => e.phoneNumberId)));
      for (const phoneNumberId of phoneNumberIds) {
        const result = await deps.processMessageEvents({
          phoneNumberId,
          events: events.filter((e) => e.phoneNumberId === phoneNumberId),
        });
        if (result.processed === 0) {
          console.warn(
            JSON.stringify({
              event: 'whatsapp_webhook_unknown_phone',
              phoneNumberIdSuffix: String(phoneNumberId).slice(-4),
            })
          );
        }
        total += result.processed;
      }

      // Coexistence fields are captured (deduplicated) and processed asynchronously.
      const coexistenceChanges = extractCoexistenceChanges(payload);
      let stored = 0;
      let duplicates = 0;
      if (coexistenceChanges.length > 0) {
        const result = await deps.storeCoexistenceChanges(coexistenceChanges, signatureSource);
        stored = result.stored;
        duplicates = result.duplicates;
      }

      res.status(200).json({ success: true, processed: total, stored, duplicates });
      if (stored > 0) deps.scheduleCoexistenceDrain();
      return;
    } catch (error) {
      console.error('WhatsApp webhook processing error');
      return res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  return router;
}

// Service modules are required lazily so importing the router factory (tests) does not
// open database / Redis / socket resources.
function createDefaultDeps(): WhatsAppWebhookRouteDeps {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const lazy = <T>(path: string) => () => require(path) as T;
  const webhookServiceMod = lazy<any>('../services/whatsappWebhookService');
  const processorMod = lazy<any>('../services/whatsappCoexistenceProcessor');
  const runtimeMod = lazy<any>('../services/whatsappCoexistenceRuntime');
  const databaseMod = lazy<any>('../config/database');
  /* eslint-enable @typescript-eslint/no-var-requires */
  const webhookService = {
    findWhatsAppConnectionsByVerifyToken: (t: string) => webhookServiceMod().findWhatsAppConnectionsByVerifyToken(t),
    findWhatsAppConnectionsForSignature: (ids: any) => webhookServiceMod().findWhatsAppConnectionsForSignature(ids),
    processMetaWhatsAppWebhookEvents: (p: any) => webhookServiceMod().processMetaWhatsAppWebhookEvents(p),
  };
  const processor = {
    storeCoexistenceChanges: (db: any, changes: any, source: any) =>
      processorMod().storeCoexistenceChanges(db, changes, source),
  };
  const runtime = { scheduleCoexistenceDrain: () => runtimeMod().scheduleCoexistenceDrain() };
  const database = { query: (text: string, params?: any[]) => databaseMod().query(text, params) };
  return {
    getPlatformAppSecret: () => getMetaAppSecret(),
    getPlatformVerifyToken: () => getMetaWhatsAppWebhookVerifyToken(),
    findConnectionsByVerifyToken: (token) => webhookService.findWhatsAppConnectionsByVerifyToken(token),
    findConnectionsForSignature: (ids) => webhookService.findWhatsAppConnectionsForSignature(ids),
    unpackAppSecret: (encrypted) => {
      try {
        return unpackWhatsAppCredentials(encrypted).appSecret;
      } catch {
        return null;
      }
    },
    processMessageEvents: (params) => webhookService.processMetaWhatsAppWebhookEvents(params),
    storeCoexistenceChanges: (changes, source) =>
      processor.storeCoexistenceChanges({ query: database.query }, changes, source),
    scheduleCoexistenceDrain: () => runtime.scheduleCoexistenceDrain(),
  };
}

export default createWhatsAppWebhookRouter(createDefaultDeps());
