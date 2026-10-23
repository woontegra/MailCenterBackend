import express, { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';

export const WHATSAPP_WEBHOOK_PATH = '/api/webhooks/whatsapp';

/** History sync deliveries can describe thousands of messages in one request. */
export const WHATSAPP_WEBHOOK_BODY_LIMIT = process.env.WHATSAPP_WEBHOOK_BODY_LIMIT || '10mb';

export function isWhatsAppWebhookPath(url: unknown): boolean {
  const path = String(url || '').split('?')[0];
  return path === WHATSAPP_WEBHOOK_PATH || path.startsWith(`${WHATSAPP_WEBHOOK_PATH}/`);
}

/**
 * JSON parser for Meta webhooks that keeps the exact raw bytes for HMAC verification.
 * Mounted before the global parser, which then skips the already-parsed body.
 */
export function createWhatsAppWebhookBodyParser(limit: string = WHATSAPP_WEBHOOK_BODY_LIMIT): RequestHandler {
  return express.json({
    limit,
    type: () => true,
    verify: (req: any, _res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  });
}

/**
 * Per-IP limiter dedicated to Meta webhook deliveries (replaces the global /api limiter,
 * which allows only 100 requests / 15 min and would drop history bursts).
 */
export function createWhatsAppWebhookRateLimiter(opts: { windowMs?: number; max?: number } = {}): RequestHandler {
  const max =
    opts.max ?? Math.max(60, Number(process.env.WHATSAPP_WEBHOOK_RATE_LIMIT_PER_MINUTE || 1200));
  return rateLimit({
    windowMs: opts.windowMs ?? 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many webhook requests' },
  });
}
