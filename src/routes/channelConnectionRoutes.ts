import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../permissions/requirePermission';
import { encryptCredential } from '../utils/mailCredentialsCrypto';
import {
  badRequest,
  canActivateChannel,
  conflict,
  isChannelStatus,
  isChannelType,
  notFound,
  sanitizeConnection,
} from '../utils/channelPlatform';
import {
  mergeSmsCredentialUpdate,
  packSmsCredentials,
  unpackSmsCredentials,
} from '../sms/smsCredentials';
import { getSmsProviderAdapter, isSupportedSmsProvider } from '../sms/smsProviderRegistry';
import {
  mergeWhatsAppCredentialUpdate,
  packWhatsAppCredentials,
  unpackWhatsAppCredentials,
  parseWhatsAppSettings,
} from '../whatsapp/whatsappCredentials';
import {
  getWhatsAppProviderAdapter,
  isSupportedWhatsAppProvider,
} from '../whatsapp/whatsappProviderRegistry';
import {
  getMetaAppSecret,
  getMetaWhatsAppWebhookVerifyToken,
} from '../config/metaWhatsAppConfig';
import { brandAccessSql } from '../services/channelConnectionBrandShareService';

const router = Router();
router.use(authenticate);

async function getOwnedBrand(brandId: number, tenantId: number) {
  const result = await query(
    `SELECT id FROM brands WHERE id = $1 AND tenant_id = $2`,
    [brandId, tenantId]
  );
  return result.rows[0] || null;
}

async function getOwnedMailAccount(mailAccountId: number, tenantId: number) {
  const result = await query(
    `SELECT id, email, name FROM mail_accounts WHERE id = $1 AND tenant_id = $2`,
    [mailAccountId, tenantId]
  );
  return result.rows[0] || null;
}

function resolveEncryptedCredentials(params: {
  channelType: string;
  provider?: string | null;
  credentials?: unknown;
  username?: unknown;
  password?: unknown;
  appname?: unknown;
  access_token?: unknown;
  app_secret?: unknown;
  webhook_verify_token?: unknown;
  existingEncrypted?: string | null;
  isUpdate?: boolean;
}): string | null {
  const provider = String(params.provider || '').toUpperCase();
  const isSmsNetgsm =
    params.channelType === 'SMS' && (provider === 'NETGSM' || isSupportedSmsProvider(provider));
  const isWaMeta =
    params.channelType === 'WHATSAPP' &&
    (provider === 'META_WHATSAPP_CLOUD' || isSupportedWhatsAppProvider(provider));

  if (isWaMeta) {
    if (params.isUpdate) {
      const tokenIn =
        params.access_token != null && String(params.access_token).trim() !== ''
          ? String(params.access_token).trim()
          : null;
      const secretIn =
        params.app_secret != null && String(params.app_secret).trim() !== ''
          ? String(params.app_secret).trim()
          : null;
      const verifyIn =
        params.webhook_verify_token != null &&
        String(params.webhook_verify_token).trim() !== ''
          ? String(params.webhook_verify_token).trim()
          : null;
      // Only fill platform secret/verify when refreshing with a new access token
      return mergeWhatsAppCredentialUpdate({
        existingEncrypted: params.existingEncrypted || null,
        access_token: tokenIn,
        app_secret: secretIn || (tokenIn ? getMetaAppSecret() || null : null),
        webhook_verify_token:
          verifyIn || (tokenIn ? getMetaWhatsAppWebhookVerifyToken() || null : null),
      });
    }
    if (params.access_token || params.app_secret || params.webhook_verify_token) {
      const accessToken = String(params.access_token || '').trim();
      const appSecret =
        String(params.app_secret || '').trim() || getMetaAppSecret();
      const webhookVerify =
        String(params.webhook_verify_token || '').trim() ||
        getMetaWhatsAppWebhookVerifyToken();
      if (accessToken && appSecret && webhookVerify) {
        return packWhatsAppCredentials({
          access_token: accessToken,
          app_secret: appSecret,
          webhook_verify_token: webhookVerify,
        });
      }
      return packWhatsAppCredentials({
        access_token: String(params.access_token || ''),
        app_secret: String(params.app_secret || ''),
        webhook_verify_token: String(params.webhook_verify_token || ''),
      });
    }
    return params.existingEncrypted || null;
  }

  if (isSmsNetgsm) {
    if (params.isUpdate) {
      return mergeSmsCredentialUpdate({
        existingEncrypted: params.existingEncrypted || null,
        username: params.username as string | null | undefined,
        password: params.password as string | null | undefined,
        appname: params.appname as string | null | undefined,
      });
    }
    if (params.username || params.password) {
      return packSmsCredentials({
        username: String(params.username || ''),
        password: String(params.password || ''),
        appname: params.appname ? String(params.appname) : null,
      });
    }
    if (typeof params.credentials === 'string' && params.credentials.trim()) {
      try {
        const parsed = JSON.parse(params.credentials);
        return packSmsCredentials(parsed);
      } catch {
        return encryptCredential(params.credentials.trim());
      }
    }
    return params.existingEncrypted || null;
  }

  if (typeof params.credentials === 'string' && params.credentials.trim()) {
    return encryptCredential(params.credentials.trim());
  }
  return params.existingEncrypted || null;
}

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { brand_id, channel_type, status } = req.query;

    let sql = `
      SELECT cc.*, b.name AS brand_name, b.accent_color AS brand_accent_color,
             owner_b.name AS owner_brand_name,
             ma.email AS mail_account_email,
             CASE
               WHEN $1::int IS NOT NULL AND cc.brand_id <> $1::int
                 AND EXISTS (
                   SELECT 1 FROM channel_connection_brand_shares sh
                   WHERE sh.tenant_id = cc.tenant_id
                     AND sh.channel_connection_id = cc.id
                     AND sh.brand_id = $1::int
                 )
               THEN true
               ELSE false
             END AS is_shared,
             (
               SELECT si.id FROM sender_identities si
               WHERE si.channel_connection_id = cc.id AND si.tenant_id = cc.tenant_id
                 AND ($1::int IS NULL OR si.brand_id = $1::int)
               ORDER BY si.is_default DESC, si.id ASC LIMIT 1
             ) AS sender_identity_id,
             COALESCE((
               SELECT json_agg(sh.brand_id ORDER BY sh.brand_id)
               FROM channel_connection_brand_shares sh
               WHERE sh.tenant_id = cc.tenant_id AND sh.channel_connection_id = cc.id
             ), '[]'::json) AS shared_brand_ids
      FROM channel_connections cc
      JOIN brands b ON b.id = cc.brand_id AND b.tenant_id = cc.tenant_id
      JOIN brands owner_b ON owner_b.id = cc.brand_id AND owner_b.tenant_id = cc.tenant_id
      LEFT JOIN mail_accounts ma ON ma.id = cc.mail_account_id AND ma.tenant_id = cc.tenant_id
      WHERE cc.tenant_id = $2
    `;

    const brandFilterId = brand_id ? Number(brand_id) : null;
    const params: unknown[] = [brandFilterId, tenantId];

    if (brand_id) {
      params.push(brand_id);
      sql += ` AND ${brandAccessSql(params.length)}`;
    }
    if (channel_type) {
      if (!isChannelType(channel_type)) {
        return badRequest(res, 'Invalid channel_type');
      }
      params.push(channel_type);
      sql += ` AND cc.channel_type = $${params.length}`;
    }
    if (status) {
      if (!isChannelStatus(String(status))) {
        return badRequest(res, 'Invalid status');
      }
      params.push(String(status).toUpperCase());
      sql += ` AND cc.status = $${params.length}`;
    }

    sql += ' ORDER BY cc.created_at DESC';

    const result = await query(sql, params);
    // Dedupe WhatsApp by phone_number_id (keep newest)
    const seenPnid = new Set<string>();
    const rows = [];
    for (const row of result.rows) {
      const sanitized = sanitizeConnection(row) as any;
      if (String(row.channel_type).toUpperCase() === 'WHATSAPP') {
        const pnid = String(sanitized.phone_number_id || '').trim();
        if (pnid) {
          if (seenPnid.has(pnid)) continue;
          seenPnid.add(pnid);
        }
        if (!pnid) continue; // compose-ready senders require phone_number_id
      }
      rows.push(sanitized);
    }
    res.json(rows);
  } catch (error) {
    console.error('Error listing channel connections:', error);
    res.status(500).json({ error: 'Failed to list channel connections' });
  }
});

router.post('/', requirePermission('CHANNEL_MANAGE'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const {
      brand_id,
      channel_type,
      provider,
      display_name,
      status = 'NOT_CONFIGURED',
      credentials,
      username,
      password,
      appname,
      access_token,
      app_secret,
      webhook_verify_token,
      mail_account_id,
      settings = {},
    } = req.body;

    const { enforceCountQuota, afterCountResourceCreated } = await import('../utils/quotaGuards');
    const channelTypeUpper = String(channel_type || '').toUpperCase();
    if (channelTypeUpper === 'SMS') {
      if (!(await enforceCountQuota(res, tenantId, 'max_sms_connections'))) return;
    } else if (channelTypeUpper === 'EMAIL') {
      if (!(await enforceCountQuota(res, tenantId, 'max_email_accounts'))) return;
    }
    // WhatsApp: enforce after we know whether this is a new ACTIVE slot or reactivation

    if (!brand_id || !isChannelType(channel_type) || !display_name) {
      return badRequest(res, 'brand_id, channel_type and display_name are required');
    }
    if (!isChannelStatus(status)) {
      return badRequest(res, 'Invalid status');
    }

    const brand = await getOwnedBrand(Number(brand_id), tenantId);
    if (!brand) return notFound(res);

    let mailAccountId: number | null = mail_account_id ? Number(mail_account_id) : null;
    if (mailAccountId) {
      const account = await getOwnedMailAccount(mailAccountId, tenantId);
      if (!account) return notFound(res);
    }

    const finalProvider =
      channel_type === 'WHATSAPP' && !provider ? 'META_WHATSAPP_CLOUD' : provider;

    let finalSettings = settings || {};
    if (channel_type === 'WHATSAPP') {
      try {
        parseWhatsAppSettings(finalSettings);
      } catch (err: any) {
        return badRequest(res, err.message || 'WhatsApp ayarları eksik');
      }
    }

    let encryptedCredentials: string | null = null;
    try {
      encryptedCredentials = resolveEncryptedCredentials({
        channelType: channel_type,
        provider: finalProvider,
        credentials,
        username,
        password,
        appname,
        access_token,
        app_secret,
        webhook_verify_token,
      });
    } catch (err: any) {
      if (err.code === 'INVALID_CREDENTIALS') {
        return badRequest(res, err.message);
      }
      throw err;
    }

    const activation = canActivateChannel({
      channelType: channel_type,
      encryptedCredentials,
      mailAccountId,
    });

    if (status === 'ACTIVE' && !activation.ok) {
      return badRequest(res, activation.error || 'Cannot activate connection');
    }

    // WhatsApp Getting Started / token refresh: same phone_number_id → update existing
    // connection (e.g. Meta Review test id=11) instead of creating a duplicate.
    if (channel_type === 'WHATSAPP') {
      const { shouldConsumeWhatsAppConnectionQuota } = await import(
        '../utils/whatsappConnectionQuota'
      );
      let phoneNumberId = '';
      try {
        phoneNumberId = parseWhatsAppSettings(finalSettings).phoneNumberId;
      } catch {
        phoneNumberId = '';
      }
      if (phoneNumberId) {
        const existing = await query(
          `SELECT * FROM channel_connections
           WHERE tenant_id = $1 AND brand_id = $2 AND channel_type = 'WHATSAPP'
             AND (
               settings->>'phone_number_id' = $3
               OR settings->>'phoneNumberId' = $3
             )
           ORDER BY id ASC
           LIMIT 1`,
          [tenantId, brand_id, phoneNumberId]
        );
        if (existing.rows[0]) {
          const current = existing.rows[0];
          if (
            shouldConsumeWhatsAppConnectionQuota({
              isNewRow: false,
              previousStatus: current.status,
              nextStatus: String(status),
            })
          ) {
            if (!(await enforceCountQuota(res, tenantId, 'max_whatsapp_connections'))) return;
          }
          const mergedSettings = {
            ...(typeof current.settings === 'object' && current.settings
              ? current.settings
              : {}),
            ...(finalSettings || {}),
          };
          const updated = await query(
            `UPDATE channel_connections
             SET provider = $1, display_name = $2, status = $3,
                 encrypted_credentials = COALESCE($4, encrypted_credentials),
                 mail_account_id = $5, settings = $6::jsonb,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $7 AND tenant_id = $8
             RETURNING *`,
            [
              finalProvider || current.provider,
              String(display_name).trim(),
              status,
              encryptedCredentials,
              mailAccountId,
              JSON.stringify(mergedSettings),
              current.id,
              tenantId,
            ]
          );
          await afterCountResourceCreated(tenantId);
          return res.json(sanitizeConnection(updated.rows[0]));
        }
      }

      if (
        shouldConsumeWhatsAppConnectionQuota({
          isNewRow: true,
          nextStatus: String(status),
        })
      ) {
        if (!(await enforceCountQuota(res, tenantId, 'max_whatsapp_connections'))) return;
      }

      if (phoneNumberId) {
        const tenantDup = await query(
          `SELECT id, brand_id FROM channel_connections
           WHERE tenant_id = $1 AND channel_type = 'WHATSAPP'
             AND (
               settings->>'phone_number_id' = $2
               OR settings->>'phoneNumberId' = $2
             )
           LIMIT 1`,
          [tenantId, phoneNumberId]
        );
        if (tenantDup.rows[0]) {
          return conflict(
            res,
            'Bu WhatsApp hattı kiracınızda zaten bağlı. Yeni bağlantı yerine mevcut hattı markanızda kullanın.'
          );
        }
      }
    }

    const result = await query(
      `INSERT INTO channel_connections
        (tenant_id, brand_id, channel_type, provider, display_name, status,
         encrypted_credentials, mail_account_id, settings)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        tenantId,
        brand_id,
        channel_type,
        finalProvider || null,
        String(display_name).trim(),
        status,
        encryptedCredentials,
        mailAccountId,
        JSON.stringify(finalSettings || {}),
      ]
    );

    await afterCountResourceCreated(tenantId);
    res.status(201).json(sanitizeConnection(result.rows[0]));
  } catch (error: any) {
    if (error.message?.includes('MAIL_CREDENTIALS_ENCRYPTION_KEY')) {
      return res.status(500).json({ error: 'Credential encryption is not configured' });
    }
    if (error.code === '23505') {
      return conflict(res, 'Channel connection already exists for this brand');
    }
    console.error('Error creating channel connection:', error);
    res.status(500).json({ error: 'Failed to create channel connection' });
  }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT * FROM channel_connections WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.user!.tenantId]
    );
    if (result.rows.length === 0) return notFound(res);
    res.json(sanitizeConnection(result.rows[0]));
  } catch (error) {
    console.error('Error fetching channel connection:', error);
    res.status(500).json({ error: 'Failed to fetch channel connection' });
  }
});

router.post('/:id/test', requirePermission('CHANNEL_MANAGE'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const result = await query(
      `SELECT * FROM channel_connections WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId]
    );
    if (result.rows.length === 0) return notFound(res);
    const connection = result.rows[0];
    const provider = String(connection.provider || '').toUpperCase();

    if (connection.channel_type === 'SMS') {
      if (!isSupportedSmsProvider(provider)) {
        return badRequest(res, 'Desteklenmeyen SMS sağlayıcısı');
      }
      if (!connection.encrypted_credentials) {
        return badRequest(res, 'Kimlik bilgileri eksik');
      }
      let credentials;
      try {
        credentials = unpackSmsCredentials(connection.encrypted_credentials);
      } catch {
        return badRequest(res, 'Kimlik bilgileri okunamadı');
      }
      const adapter = getSmsProviderAdapter(provider);
      const test = await adapter.testConnection(credentials);
      await query(
        `UPDATE channel_connections
         SET status = CASE WHEN $3 = true AND status <> 'DISABLED' THEN 'ACTIVE'
                           WHEN $3 = false THEN 'ERROR'
                           ELSE status END,
             last_tested_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND tenant_id = $2`,
        [connection.id, tenantId, test.ok]
      );
      return res.json({
        success: test.ok,
        status: test.ok ? (connection.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE') : 'ERROR',
        message: test.safeMessage,
        code: test.code || null,
        headers_count: test.headers?.length || 0,
        pending_first_send: Boolean(test.pendingFirstSend),
      });
    }

    if (connection.channel_type === 'WHATSAPP') {
      if (!isSupportedWhatsAppProvider(provider)) {
        return badRequest(res, 'Desteklenmeyen WhatsApp sağlayıcısı');
      }
      if (!connection.encrypted_credentials) {
        return badRequest(res, 'Kimlik bilgileri eksik');
      }
      let credentials;
      let config;
      try {
        credentials = unpackWhatsAppCredentials(connection.encrypted_credentials);
        config = parseWhatsAppSettings(connection.settings);
      } catch (err: any) {
        return badRequest(res, err.message || 'WhatsApp yapılandırması okunamadı');
      }
      const adapter = getWhatsAppProviderAdapter(provider);
      const test = await adapter.testConnection(credentials, config);
      await query(
        `UPDATE channel_connections
         SET status = CASE WHEN $3 = true AND status <> 'DISABLED' THEN 'ACTIVE'
                           WHEN $3 = false THEN 'ERROR'
                           ELSE status END,
             last_tested_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND tenant_id = $2`,
        [connection.id, tenantId, test.ok]
      );
      return res.json({
        success: test.ok,
        status: test.ok ? (connection.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE') : 'ERROR',
        message: test.safeMessage,
        code: test.code || null,
        display_phone_number: test.displayPhoneNumber || null,
        pending_first_send: Boolean(test.pendingFirstSend),
      });
    }

    return badRequest(res, 'Bu test yalnızca SMS veya WhatsApp kanal bağlantıları için geçerlidir');
  } catch (error: any) {
    console.error('Error testing channel connection:', error?.message || error);
    res.status(500).json({
      success: false,
      error: 'Bağlantı testi tamamlanamadı',
    });
  }
});

router.patch('/:id', requirePermission('CHANNEL_MANAGE'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const existingResult = await query(
      `SELECT * FROM channel_connections WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId]
    );
    if (existingResult.rows.length === 0) return notFound(res);

    const current = existingResult.rows[0];
    const {
      provider = current.provider,
      display_name = current.display_name,
      status = current.status,
      credentials,
      username,
      password,
      appname,
      access_token,
      app_secret,
      webhook_verify_token,
      mail_account_id = current.mail_account_id,
      settings = current.settings,
    } = req.body;

    if (!isChannelStatus(status)) {
      return badRequest(res, 'Invalid status');
    }

    let mailAccountId: number | null =
      mail_account_id === null || mail_account_id === ''
        ? null
        : Number(mail_account_id);

    if (mailAccountId) {
      const account = await getOwnedMailAccount(mailAccountId, tenantId);
      if (!account) return notFound(res);
    }

    if (current.channel_type === 'WHATSAPP') {
      try {
        parseWhatsAppSettings(settings || {});
      } catch (err: any) {
        return badRequest(res, err.message || 'WhatsApp ayarları eksik');
      }
    }

    let encryptedCredentials = current.encrypted_credentials;
    try {
      encryptedCredentials = resolveEncryptedCredentials({
        channelType: current.channel_type,
        provider,
        credentials,
        username,
        password,
        appname,
        access_token,
        app_secret,
        webhook_verify_token,
        existingEncrypted: current.encrypted_credentials,
        isUpdate: true,
      });
    } catch (err: any) {
      if (err.code === 'INVALID_CREDENTIALS') {
        return badRequest(res, err.message);
      }
      throw err;
    }

    const activation = canActivateChannel({
      channelType: current.channel_type,
      encryptedCredentials,
      mailAccountId,
    });

    if (status === 'ACTIVE' && !activation.ok) {
      return badRequest(res, activation.error || 'Cannot activate connection');
    }

    const result = await query(
      `UPDATE channel_connections
       SET provider = $1, display_name = $2, status = $3,
           encrypted_credentials = $4, mail_account_id = $5, settings = $6,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $7 AND tenant_id = $8
       RETURNING *`,
      [
        provider || null,
        String(display_name).trim(),
        status,
        encryptedCredentials,
        mailAccountId,
        JSON.stringify(settings || {}),
        req.params.id,
        tenantId,
      ]
    );

    res.json(sanitizeConnection(result.rows[0]));
  } catch (error: any) {
    if (error.message?.includes('MAIL_CREDENTIALS_ENCRYPTION_KEY')) {
      return res.status(500).json({ error: 'Credential encryption is not configured' });
    }
    if (error.code === '23505') {
      return conflict(res, 'Channel connection already exists for this brand');
    }
    console.error('Error updating channel connection:', error);
    res.status(500).json({ error: 'Failed to update channel connection' });
  }
});

router.delete('/:id', requirePermission('CHANNEL_MANAGE'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const existing = await query(
      `SELECT id FROM channel_connections WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId]
    );
    if (existing.rows.length === 0) return notFound(res);

    const linkedSenders = await query(
      `SELECT COUNT(*)::int AS count
       FROM sender_identities
       WHERE channel_connection_id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId]
    );

    if (linkedSenders.rows[0].count > 0) {
      return conflict(res, 'Channel connection has linked sender identities and cannot be deleted');
    }

    await query(`DELETE FROM channel_connections WHERE id = $1 AND tenant_id = $2`, [
      req.params.id,
      tenantId,
    ]);

    res.json({ message: 'Channel connection deleted successfully' });
  } catch (error: any) {
    if (error.code === '23503') {
      return conflict(res, 'Channel connection has linked records and cannot be deleted');
    }
    console.error('Error deleting channel connection:', error);
    res.status(500).json({ error: 'Failed to delete channel connection' });
  }
});

/**
 * Ensure WhatsApp sender_identity for an ACTIVE channel connection (compose helper).
 */
router.post(
  '/:id/ensure-whatsapp-sender',
  requirePermission('WHATSAPP_SEND'),
  async (req: AuthRequest, res: Response) => {
    try {
      const tenantId = req.user!.tenantId;
      const id = Number(req.params.id);
      if (!id) return badRequest(res, 'Geçersiz kanal');

      const { ensureWhatsAppSenderForConnection, respondSenderResolveError } = await import(
        '../utils/senderIdentityAccess'
      );
      let ensured;
      try {
        const targetBrandId = req.body?.brand_id ? Number(req.body.brand_id) : null;
        ensured = await ensureWhatsAppSenderForConnection(id, tenantId, targetBrandId);
      } catch (error: any) {
        return respondSenderResolveError(res, error);
      }
      if (!ensured) return notFound(res);

      res.json({ success: true, data: ensured });
    } catch (error) {
      console.error('Ensure WhatsApp sender error');
      res.status(500).json({ error: 'WhatsApp göndericisi hazırlanamadı' });
    }
  }
);

router.get('/whatsapp/shareable-lines', async (req: AuthRequest, res: Response) => {
  try {
    const brandId = Number(req.query.brand_id || req.query.brandId || '');
    if (!brandId) return badRequest(res, 'brand_id gerekli');
    const { listShareableWhatsAppLines } = await import(
      '../services/channelConnectionBrandShareService'
    );
    const brandOk = await query(`SELECT id FROM brands WHERE id = $1 AND tenant_id = $2`, [
      brandId,
      req.user!.tenantId,
    ]);
    if (brandOk.rows.length === 0) return notFound(res);
    const lines = await listShareableWhatsAppLines(req.user!.tenantId, brandId);
    res.json({
      success: true,
      data: lines.map((line) => ({
        id: line.id,
        label: line.label,
        owner_brand_name: line.owner_brand_name,
        phone_number: line.phone_number,
      })),
    });
  } catch (error) {
    console.error('shareable-lines error', error);
    res.status(500).json({ error: 'Paylaşılabilir hatlar alınamadı' });
  }
});

router.post(
  '/:id/share-with-brand',
  requirePermission('CHANNEL_MANAGE'),
  async (req: AuthRequest, res: Response) => {
    try {
      const brandId = Number(req.body?.brand_id || req.body?.brandId || '');
      if (!brandId) return badRequest(res, 'brand_id gerekli');
      const { shareWhatsAppConnectionWithBrand } = await import(
        '../services/channelConnectionBrandShareService'
      );
      const result = await shareWhatsAppConnectionWithBrand({
        tenantId: req.user!.tenantId,
        connectionId: Number(req.params.id),
        brandId,
        userId: req.user!.userId,
      });
      res.json({ success: true, data: result });
    } catch (error: any) {
      res.status(error.status || 500).json({
        success: false,
        error: error.message || 'Hat paylaşılamadı',
      });
    }
  }
);

router.delete(
  '/:id/share-with-brand/:brandId',
  requirePermission('CHANNEL_MANAGE'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { unshareWhatsAppConnectionFromBrand } = await import(
        '../services/channelConnectionBrandShareService'
      );
      const result = await unshareWhatsAppConnectionFromBrand({
        tenantId: req.user!.tenantId,
        connectionId: Number(req.params.id),
        brandId: Number(req.params.brandId),
      });
      res.json({ success: true, data: result });
    } catch (error: any) {
      res.status(error.status || 500).json({
        success: false,
        error: error.message || 'Paylaşım kaldırılamadı',
      });
    }
  }
);

export default router;
