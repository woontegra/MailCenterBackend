import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../permissions/requirePermission';
import { badRequest, notFound, sanitizeConnection, conflict } from '../utils/channelPlatform';
import {
  getMetaWhatsAppPublicConfig,
  getMetaGraphApiVersion,
  isMetaEmbeddedSignupReady,
} from '../config/metaWhatsAppConfig';
import {
  exchangeEmbeddedSignupCode,
  extractSignupIds,
  fetchPhoneNumberProfile,
  fetchWabaProfile,
  packPlatformWhatsAppCredentials,
  resolvePhoneNumberIdForWaba,
  subscribeAppToWaba,
  unsubscribeAppFromWaba,
  verifyConnectionAgainstMeta,
  MetaSignupSessionInfo,
} from '../services/metaEmbeddedSignupService';
import {
  syncWhatsAppTemplatesForConnection,
  safeTemplateSyncError,
} from '../services/whatsappTemplateSyncService';
import {
  unpackWhatsAppCredentials,
  parseWhatsAppSettings,
} from '../whatsapp/whatsappCredentials';
import { sanitizeOutboundErrorMessage } from '../config/outboundQueue';
import { getWhatsAppProviderAdapter } from '../whatsapp/whatsappProviderRegistry';
import { formatWhatsAppSendFailureMessage } from '../whatsapp/providers/metaWhatsAppCloudAdapter';

const router = Router();
router.use(authenticate);

const signupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Çok fazla deneme. Lütfen sonra tekrar deneyin.' },
});

function sanitizeErr(err: any, fallback: string): string {
  return sanitizeOutboundErrorMessage(err?.message || fallback);
}

/**
 * GET /api/channel-connections/whatsapp/meta-setup-status
 * Public flags only — no secrets.
 */
router.get('/whatsapp/meta-setup-status', requirePermission('CHANNEL_MANAGE'), async (_req, res) => {
  const cfg = getMetaWhatsAppPublicConfig();
  res.json({
    ...cfg,
    embeddedSignupReady: isMetaEmbeddedSignupReady() && cfg.publicBackendUrlPresent,
    message: cfg.configured
      ? 'Meta Embedded Signup yapılandırması hazır'
      : 'Meta WhatsApp yapılandırması tamamlanmamış',
  });
});

/**
 * POST /api/channel-connections/whatsapp/embedded-signup/complete
 */
router.post(
  '/whatsapp/embedded-signup/complete',
  requirePermission('CHANNEL_MANAGE'),
  signupLimiter,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!isMetaEmbeddedSignupReady()) {
        return badRequest(res, 'Meta WhatsApp yapılandırması tamamlanmamış');
      }

      const tenantId = req.user!.tenantId;
      const brandId = Number(req.body?.brandId || req.body?.brand_id);
      const authorizationCode = String(
        req.body?.authorizationCode || req.body?.authorization_code || ''
      ).trim();
      const sessionRaw = req.body?.sessionInfo || req.body?.session_info || req.body?.metaSession || null;
      const onboardingModeRaw = String(
        req.body?.onboardingMode || req.body?.onboarding_mode || req.body?.connectionType || ''
      )
        .trim()
        .toUpperCase();
      const isCoexistenceOnboarding =
        onboardingModeRaw === 'WHATSAPP_BUSINESS_APP_ONBOARDING' ||
        onboardingModeRaw === 'COEXISTENCE' ||
        String(sessionRaw?.event || '')
          .toUpperCase()
          .includes('WHATSAPP_BUSINESS_APP_ONBOARDING');
      const connectionType = isCoexistenceOnboarding
        ? 'WHATSAPP_BUSINESS_APP_ONBOARDING'
        : 'STANDARD_EMBEDDED_SIGNUP';

      if (!brandId || Number.isNaN(brandId)) {
        return badRequest(res, 'brandId gerekli');
      }
      if (!authorizationCode) {
        return badRequest(res, 'authorizationCode gerekli');
      }

      const brand = await query(`SELECT id, name FROM brands WHERE id = $1 AND tenant_id = $2`, [
        brandId,
        tenantId,
      ]);
      if (brand.rows.length === 0) return notFound(res);

      let session: MetaSignupSessionInfo = {};
      if (sessionRaw && typeof sessionRaw === 'object') {
        const nested =
          sessionRaw.data && typeof sessionRaw.data === 'object' ? sessionRaw.data : {};
        session = {
          wabaId: sessionRaw.wabaId || sessionRaw.waba_id || nested.waba_id || null,
          phoneNumberId:
            sessionRaw.phoneNumberId ||
            sessionRaw.phone_number_id ||
            nested.phone_number_id ||
            null,
          businessId:
            sessionRaw.businessId || sessionRaw.business_id || nested.business_id || null,
          raw: sessionRaw,
        };
      }

      let ids;
      try {
        ids = extractSignupIds(session, {
          allowMissingPhoneNumberId: isCoexistenceOnboarding,
        });
      } catch (err: any) {
        return badRequest(res, sanitizeErr(err, 'Meta oturum bilgileri eksik'));
      }

      // Do not create ACTIVE row until all critical steps succeed
      let accessToken: string;
      try {
        const exchanged = await exchangeEmbeddedSignupCode(authorizationCode);
        accessToken = exchanged.accessToken;
      } catch (err: any) {
        return badRequest(res, sanitizeErr(err, 'Authorization code işlenemedi'));
      }

      // Coexistence FINISH often returns only waba_id — resolve phone number via Graph.
      // Do NOT call the Cloud API register endpoint; number stays on WhatsApp Business app.
      if (!ids.phoneNumberId) {
        try {
          const resolved = await resolvePhoneNumberIdForWaba({
            accessToken,
            wabaId: ids.wabaId,
          });
          ids = { ...ids, phoneNumberId: resolved.phoneNumberId };
        } catch (err: any) {
          return badRequest(res, sanitizeErr(err, 'Coexistence telefon numarası çözülemedi'));
        }
      }

      let phone;
      let waba;
      try {
        phone = await fetchPhoneNumberProfile({
          accessToken,
          phoneNumberId: ids.phoneNumberId,
        });
        waba = await fetchWabaProfile({
          accessToken,
          wabaId: ids.wabaId,
        });
      } catch (err: any) {
        return badRequest(res, sanitizeErr(err, 'WABA / telefon doğrulaması başarısız'));
      }

      try {
        await subscribeAppToWaba({
          accessToken,
          wabaId: ids.wabaId,
        });
      } catch (err: any) {
        return badRequest(res, sanitizeErr(err, 'WABA webhook aboneliği başarısız'));
      }

      const encrypted = packPlatformWhatsAppCredentials(accessToken);
      const apiVersion = getMetaGraphApiVersion();
      const settings = {
        waba_id: ids.wabaId,
        phone_number_id: ids.phoneNumberId,
        business_id: ids.businessId,
        business_phone_number: phone.displayPhoneNumber,
        verified_name: phone.verifiedName,
        quality_rating: phone.qualityRating,
        waba_name: waba.name,
        api_version: apiVersion,
        webhook_status: 'SUBSCRIBED',
        connection_method: 'EMBEDDED_SIGNUP',
        connection_type: connectionType,
        coexistence: isCoexistenceOnboarding,
        last_inbound_at: null,
        last_outbound_at: null,
        last_error: null,
      };

      const displayName =
        phone.verifiedName ||
        phone.displayPhoneNumber ||
        `WhatsApp ${ids.phoneNumberId}`;

      // Upsert: one WA connection per brand preferred
      const existing = await query(
        `SELECT id FROM channel_connections
         WHERE tenant_id = $1 AND brand_id = $2 AND channel_type = 'WHATSAPP'
         ORDER BY id ASC LIMIT 1`,
        [tenantId, brandId]
      );

      let saved;
      if (existing.rows[0]?.id) {
        saved = await query(
          `UPDATE channel_connections
           SET provider = 'META_WHATSAPP_CLOUD',
               display_name = $1,
               status = 'ACTIVE',
               encrypted_credentials = $2,
               settings = $3::jsonb,
               last_tested_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $4 AND tenant_id = $5
           RETURNING *`,
          [
            displayName,
            encrypted,
            JSON.stringify(settings),
            existing.rows[0].id,
            tenantId,
          ]
        );
      } else {
        const { enforceCountQuota, afterCountResourceCreated } = await import('../utils/quotaGuards');
        if (!(await enforceCountQuota(res, tenantId, 'max_whatsapp_connections'))) return;

        saved = await query(
          `INSERT INTO channel_connections
            (tenant_id, brand_id, channel_type, provider, display_name, status,
             encrypted_credentials, settings, last_tested_at)
           VALUES ($1,$2,'WHATSAPP','META_WHATSAPP_CLOUD',$3,'ACTIVE',$4,$5::jsonb,CURRENT_TIMESTAMP)
           RETURNING *`,
          [tenantId, brandId, displayName, encrypted, JSON.stringify(settings)]
        );
        await afterCountResourceCreated(tenantId);
      }

      const connection = saved.rows[0];

      // Best-effort sender identity
      try {
        const phoneValue = phone.displayPhoneNumber || ids.phoneNumberId;
        const idCheck = await query(
          `SELECT id FROM sender_identities
           WHERE tenant_id = $1 AND brand_id = $2 AND channel_connection_id = $3
           LIMIT 1`,
          [tenantId, brandId, connection.id]
        );
        if (!idCheck.rows[0]) {
          await query(
            `INSERT INTO sender_identities
              (tenant_id, brand_id, channel_connection_id, channel_type, display_name, sender_value, is_default, is_active, is_verified)
             VALUES ($1,$2,$3,'WHATSAPP',$4,$5,true,true,true)`,
            [tenantId, brandId, connection.id, displayName, phoneValue]
          );
        }
      } catch {
        /* sender identity optional for connection success */
      }

      // Best-effort template sync — connection already ACTIVE
      let templateSync: { synced: number; approved: number } | null = null;
      try {
        const sync = await syncWhatsAppTemplatesForConnection({
          tenantId,
          connectionId: connection.id,
        });
        templateSync = { synced: sync.synced, approved: sync.approved };
      } catch {
        templateSync = null;
      }

      return res.status(201).json({
        success: true,
        connection: sanitizeConnection(connection),
        connectionType,
        coexistence: isCoexistenceOnboarding,
        phone: {
          phoneNumberId: phone.phoneNumberId,
          displayPhoneNumber: phone.displayPhoneNumber,
          verifiedName: phone.verifiedName,
          qualityRating: phone.qualityRating,
        },
        waba: {
          wabaId: waba.wabaId,
          name: waba.name,
        },
        webhookSubscribed: true,
        templateSync,
      });
    } catch (error: any) {
      if (error.code === '23505') {
        return conflict(res, 'Bu marka için WhatsApp bağlantısı zaten var');
      }
      console.error('Embedded signup complete error');
      return res.status(500).json({ error: 'WhatsApp Embedded Signup tamamlanamadı' });
    }
  }
);

/**
 * POST /api/channel-connections/:id/whatsapp/sync-templates
 */
router.post(
  '/:id/whatsapp/sync-templates',
  requirePermission('CHANNEL_MANAGE'),
  async (req: AuthRequest, res: Response) => {
    try {
      const tenantId = req.user!.tenantId;
      const id = Number(req.params.id);
      const result = await syncWhatsAppTemplatesForConnection({
        tenantId,
        connectionId: id,
      });
      res.json({
        success: true,
        synced: result.synced,
        approved: result.approved,
      });
    } catch (err: any) {
      if (err.code === 'NOT_FOUND') return notFound(res);
      // Persist sync error message without flipping connection to ERROR.
      try {
        const tenantId = req.user!.tenantId;
        const id = Number(req.params.id);
        const existing = await query(
          `SELECT settings, status FROM channel_connections
           WHERE id = $1 AND tenant_id = $2 AND channel_type = 'WHATSAPP'`,
          [id, tenantId]
        );
        if (existing.rows[0]) {
          const settings = {
            ...(existing.rows[0].settings || {}),
            last_template_sync_error: safeTemplateSyncError(err),
          };
          await query(
            `UPDATE channel_connections
             SET settings = $1::jsonb, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2 AND tenant_id = $3`,
            [JSON.stringify(settings), id, tenantId]
          );
        }
      } catch {
        /* best-effort only */
      }
      return badRequest(res, safeTemplateSyncError(err));
    }
  }
);

/**
 * POST /api/channel-connections/:id/whatsapp/verify
 * Real Meta checks: token, WABA, phone, subscription.
 */
router.post(
  '/:id/whatsapp/verify',
  requirePermission('CHANNEL_MANAGE'),
  async (req: AuthRequest, res: Response) => {
    try {
      const tenantId = req.user!.tenantId;
      const result = await query(
        `SELECT * FROM channel_connections
         WHERE id = $1 AND tenant_id = $2 AND channel_type = 'WHATSAPP'`,
        [req.params.id, tenantId]
      );
      if (result.rows.length === 0) return notFound(res);
      const connection = result.rows[0];
      const creds = unpackWhatsAppCredentials(connection.encrypted_credentials);
      const config = parseWhatsAppSettings(connection.settings);

      const verification = await verifyConnectionAgainstMeta({
        accessToken: creds.accessToken,
        wabaId: config.wabaId,
        phoneNumberId: config.phoneNumberId,
        apiVersion: config.apiVersion,
      });

      const settings = {
        ...(connection.settings || {}),
        verified_name: verification.phone.verifiedName,
        quality_rating: verification.phone.qualityRating,
        business_phone_number:
          verification.phone.displayPhoneNumber || connection.settings?.business_phone_number,
        waba_name: verification.waba.name,
        webhook_status: verification.subscribed ? 'SUBSCRIBED' : 'NOT_SUBSCRIBED',
        last_error: verification.subscribed ? null : verification.safeMessage,
      };

      await query(
        `UPDATE channel_connections
         SET status = CASE WHEN $3 = true THEN 'ACTIVE' ELSE 'ERROR' END,
             settings = $4::jsonb,
             last_tested_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND tenant_id = $2`,
        [connection.id, tenantId, verification.ok && verification.subscribed, JSON.stringify(settings)]
      );

      res.json({
        success: verification.ok && verification.subscribed,
        subscribed: verification.subscribed,
        message: verification.safeMessage,
        phone: {
          displayPhoneNumber: verification.phone.displayPhoneNumber,
          verifiedName: verification.phone.verifiedName,
          qualityRating: verification.phone.qualityRating,
        },
        waba: { wabaId: verification.waba.wabaId, name: verification.waba.name },
      });
    } catch (err: any) {
      return badRequest(res, sanitizeErr(err, 'Bağlantı doğrulaması başarısız'));
    }
  }
);

/**
 * POST /api/channel-connections/:id/whatsapp/disconnect
 * Soft-disable: keep history, revoke local token access.
 */
router.post(
  '/:id/whatsapp/disconnect',
  requirePermission('CHANNEL_MANAGE'),
  async (req: AuthRequest, res: Response) => {
    try {
      const tenantId = req.user!.tenantId;
      const result = await query(
        `SELECT * FROM channel_connections
         WHERE id = $1 AND tenant_id = $2 AND channel_type = 'WHATSAPP'`,
        [req.params.id, tenantId]
      );
      if (result.rows.length === 0) return notFound(res);
      const connection = result.rows[0];

      let unsubscribed = false;
      try {
        const creds = unpackWhatsAppCredentials(connection.encrypted_credentials);
        const config = parseWhatsAppSettings(connection.settings);
        // Only unsubscribe if no other ACTIVE connection shares this WABA
        const others = await query(
          `SELECT id FROM channel_connections
           WHERE channel_type = 'WHATSAPP'
             AND status = 'ACTIVE'
             AND id <> $1
             AND settings->>'waba_id' = $2`,
          [connection.id, config.wabaId]
        );
        if (others.rows.length === 0) {
          await unsubscribeAppFromWaba({
            accessToken: creds.accessToken,
            wabaId: config.wabaId,
            apiVersion: config.apiVersion,
          });
          unsubscribed = true;
        }
      } catch {
        /* still disable locally */
      }

      const settings = {
        ...(connection.settings || {}),
        webhook_status: unsubscribed ? 'UNSUBSCRIBED' : connection.settings?.webhook_status,
        disconnected_at: new Date().toISOString(),
        last_error: null,
      };

      const updated = await query(
        `UPDATE channel_connections
         SET status = 'DISABLED',
             encrypted_credentials = NULL,
             settings = $1::jsonb,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND tenant_id = $3
         RETURNING *`,
        [JSON.stringify(settings), connection.id, tenantId]
      );

      res.json({
        success: true,
        unsubscribed,
        connection: sanitizeConnection(updated.rows[0]),
        message: 'WhatsApp bağlantısı pasifleştirildi. Geçmiş konuşmalar korundu.',
      });
    } catch (err: any) {
      return badRequest(res, sanitizeErr(err, 'Bağlantı kaldırılamadı'));
    }
  }
);

/**
 * POST /api/channel-connections/:id/whatsapp/test-template
 * Send a real template message; success only with Meta wamid.
 */
router.post(
  '/:id/whatsapp/test-template',
  requirePermission('CHANNEL_MANAGE'),
  signupLimiter,
  async (req: AuthRequest, res: Response) => {
    try {
      const tenantId = req.user!.tenantId;
      const to = String(req.body?.to || req.body?.phone || '').trim();
      const templateName = String(req.body?.templateName || req.body?.template_name || '').trim();
      const language = String(req.body?.language || req.body?.languageCode || 'tr').trim();
      const components = Array.isArray(req.body?.components) ? req.body.components : undefined;

      if (!to || !templateName) {
        return badRequest(res, 'Test telefonu ve şablon adı gerekli');
      }

      const result = await query(
        `SELECT * FROM channel_connections
         WHERE id = $1 AND tenant_id = $2 AND channel_type = 'WHATSAPP' AND status = 'ACTIVE'`,
        [req.params.id, tenantId]
      );
      if (result.rows.length === 0) return notFound(res);
      const connection = result.rows[0];
      const creds = unpackWhatsAppCredentials(connection.encrypted_credentials);
      const config = parseWhatsAppSettings(connection.settings);
      const adapter = getWhatsAppProviderAdapter(connection.provider);

      const digits = to.replace(/\D/g, '');
      let send;
      try {
        send = await adapter.sendTemplateMessage(creds, {
          toE164: to.startsWith('+') ? to : `+${digits}`,
          toProviderNumber: digits,
          phoneNumberId: config.phoneNumberId,
          apiVersion: config.apiVersion,
          templateName,
          languageCode: language,
          components,
        });
      } catch (sendErr: any) {
        const graphData = sendErr?.graphError;
        const msg = graphData
          ? formatWhatsAppSendFailureMessage(graphData, sendErr?.status)
          : sanitizeErr(sendErr, 'WhatsApp mesajı gönderilemedi');
        return badRequest(res, msg.startsWith('WhatsApp mesajı gönderilemedi:')
          ? msg
          : `WhatsApp mesajı gönderilemedi: ${msg}`);
      }

      if (!send.success || !send.providerMessageId) {
        return badRequest(
          res,
          'WhatsApp mesajı gönderilemedi: Meta messages[0].id dönmedi'
        );
      }

      const settings = {
        ...(connection.settings || {}),
        last_outbound_at: new Date().toISOString(),
      };
      await query(
        `UPDATE channel_connections
         SET settings = $1::jsonb, last_tested_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND tenant_id = $3`,
        [JSON.stringify(settings), connection.id, tenantId]
      );

      res.json({
        success: true,
        wamid: send.providerMessageId,
        message: 'Test şablon mesajı Meta’ya iletildi',
      });
    } catch (err: any) {
      return badRequest(res, sanitizeErr(err, 'Test mesajı başarısız'));
    }
  }
);

export default router;
