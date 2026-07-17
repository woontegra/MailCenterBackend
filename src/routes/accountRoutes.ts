import { Router, Response } from 'express';
import { query, withTransaction } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';
import { trackUsage } from '../middleware/usageLimit';
import { encryptCredential } from '../utils/mailCredentialsCrypto';
import {
  ACCOUNT_LIST_SELECT,
  isProductionWithoutEncryptionKey,
  migrateLegacyCredentials,
  normalizeProvider,
  PUBLIC_MAIL_ACCOUNT_FIELDS,
  requireMailCredentialEncryption,
  sanitizeMailAccount,
  sanitizeMailAccounts,
  withDecryptedCredentials,
} from '../utils/mailAccountUtils';
import { testMailConnection } from '../services/mailConnectionTestService';
import { notFound, badRequest } from '../utils/channelPlatform';
import { isBrandDomainDeliverabilityValid } from '../utils/brandDeliverability';
import { extractEmailDomain, normalizeDomainInput } from '../utils/domainValidation';
import { publishMailAccountEvent } from '../services/redisEventBus';

const router = Router();

router.use(authenticate);

function mapConnectionError(error?: string) {
  switch (error) {
    case 'incomplete_config':
      return 'Bağlantı bilgileri eksik';
    case 'timeout':
      return 'Bağlantı zaman aşımına uğradı';
    case 'connection_failed':
      return 'IMAP veya SMTP bağlantısı başarısız';
    default:
      return 'Bağlantı testi başarısız';
  }
}

async function getOwnedBrand(brandId: number, tenantId: number) {
  const result = await query(
    `SELECT id, name, domain FROM brands WHERE id = $1 AND tenant_id = $2`,
    [brandId, tenantId]
  );
  return result.rows[0] || null;
}

async function loadAccountForTenant(accountId: number, tenantId: number) {
  const result = await query(
    `SELECT * FROM mail_accounts WHERE id = $1 AND tenant_id = $2`,
    [accountId, tenantId]
  );
  return result.rows[0] || null;
}

async function fetchAccountDetail(accountId: number, tenantId: number) {
  const result = await query(
    `SELECT ${ACCOUNT_LIST_SELECT}
     FROM mail_accounts ma
     LEFT JOIN LATERAL (
       SELECT id, brand_id, status, last_tested_at
       FROM channel_connections
       WHERE mail_account_id = ma.id
         AND tenant_id = ma.tenant_id
         AND channel_type = 'EMAIL'
       ORDER BY id ASC
       LIMIT 1
     ) cc ON true
     LEFT JOIN brands b
       ON b.id = cc.brand_id AND b.tenant_id = ma.tenant_id
     LEFT JOIN LATERAL (
       SELECT id, display_name, reply_to
       FROM sender_identities
       WHERE channel_connection_id = cc.id
         AND tenant_id = ma.tenant_id
       ORDER BY is_default DESC, id ASC
       LIMIT 1
     ) si ON true
     WHERE ma.id = $1 AND ma.tenant_id = $2`,
    [accountId, tenantId]
  );
  return result.rows[0] || null;
}

router.post('/test-connection', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { account_id } = req.body;

    let input = {
      email: req.body.email as string | undefined,
      imap_host: req.body.imap_host as string,
      imap_port: Number(req.body.imap_port) || 993,
      imap_user: req.body.imap_user as string,
      imap_password: req.body.imap_password as string,
      imap_secure: req.body.imap_secure !== false && req.body.imap_secure !== 'false',
      smtp_host: req.body.smtp_host as string | undefined,
      smtp_port: req.body.smtp_port ? Number(req.body.smtp_port) : 587,
      smtp_user: (req.body.smtp_user || req.body.imap_user) as string | undefined,
      smtp_password: (req.body.smtp_password || req.body.imap_password) as string | undefined,
      smtp_secure: Boolean(req.body.smtp_secure),
    };

    if (account_id) {
      const account = await loadAccountForTenant(Number(account_id), tenantId);
      if (!account) return notFound(res);

      await migrateLegacyCredentials(Number(account_id), tenantId);
      const refreshed = await loadAccountForTenant(Number(account_id), tenantId);
      const decrypted = withDecryptedCredentials(refreshed);

      const passwordOverride =
        typeof req.body.imap_password === 'string' && req.body.imap_password.length > 0
          ? req.body.imap_password
          : decrypted.imap_password;
      const smtpPasswordOverride =
        typeof req.body.smtp_password === 'string' && req.body.smtp_password.length > 0
          ? req.body.smtp_password
          : decrypted.smtp_password || passwordOverride;

      input = {
        email: decrypted.email,
        imap_host: req.body.imap_host || decrypted.imap_host,
        imap_port: Number(req.body.imap_port || decrypted.imap_port || 993),
        imap_user: req.body.imap_user || decrypted.imap_user,
        imap_password: passwordOverride,
        imap_secure:
          req.body.imap_secure !== undefined
            ? req.body.imap_secure !== false && req.body.imap_secure !== 'false'
            : decrypted.imap_secure !== false,
        smtp_host: req.body.smtp_host ?? decrypted.smtp_host,
        smtp_port: Number(req.body.smtp_port || decrypted.smtp_port || 587),
        smtp_user: req.body.smtp_user || decrypted.smtp_user || decrypted.imap_user,
        smtp_password: smtpPasswordOverride,
        smtp_secure:
          req.body.smtp_secure !== undefined
            ? Boolean(req.body.smtp_secure)
            : Boolean(decrypted.smtp_secure),
      };
    }

    if (!input.imap_host || !input.imap_user || !input.imap_password) {
      return badRequest(res, mapConnectionError('incomplete_config'));
    }

    const result = await testMailConnection(input);

    if (account_id) {
      await query(
        `UPDATE mail_accounts
         SET imap_connection_status = $1,
             smtp_connection_status = $2,
             last_connection_test_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3 AND tenant_id = $4`,
        [
          result.imap_ok ? 'ok' : 'error',
          result.smtp_ok ? 'ok' : 'error',
          Number(account_id),
          tenantId,
        ]
      );

      await query(
        `UPDATE channel_connections
         SET status = $1,
             last_tested_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE mail_account_id = $2
           AND tenant_id = $3
           AND channel_type = 'EMAIL'`,
        [result.success ? 'ACTIVE' : 'ERROR', Number(account_id), tenantId]
      );

      if (result.success) {
        // Only newly verify when brand domain deliverability is VALID; do not demote existing
        const link = await query(
          `SELECT cc.brand_id
           FROM channel_connections cc
           WHERE cc.mail_account_id = $1 AND cc.tenant_id = $2 AND cc.channel_type = 'EMAIL'
           ORDER BY cc.id ASC LIMIT 1`,
          [Number(account_id), tenantId]
        );
        const brandIdForVerify = link.rows[0]?.brand_id;
        const domainReady = brandIdForVerify
          ? await isBrandDomainDeliverabilityValid(tenantId, Number(brandIdForVerify))
          : false;

        if (domainReady) {
          await query(
            `UPDATE sender_identities si
             SET is_verified = true, is_active = true, updated_at = CURRENT_TIMESTAMP
             FROM channel_connections cc
             WHERE si.channel_connection_id = cc.id
               AND si.tenant_id = cc.tenant_id
               AND cc.mail_account_id = $1
               AND cc.tenant_id = $2
               AND cc.channel_type = 'EMAIL'`,
            [Number(account_id), tenantId]
          );
        }
      }
    }

    return res.json({
      success: result.success,
      imap_ok: result.imap_ok,
      smtp_ok: result.smtp_ok,
      message: result.success ? 'Bağlantı başarılı' : mapConnectionError(result.error),
    });
  } catch (error: any) {
    console.error('Error testing mail connection:', error.message || error);
    return res.status(500).json({
      success: false,
      imap_ok: false,
      smtp_ok: false,
      error: 'Bağlantı testi tamamlanamadı',
    });
  }
});

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { enforceCountQuota, afterCountResourceCreated } = await import('../utils/quotaGuards');
    if (!(await enforceCountQuota(res, req.user!.tenantId, 'max_email_accounts'))) return;

    if (isProductionWithoutEncryptionKey()) {
      return res.status(503).json({
        error: 'Hesap kaydı için şifreleme anahtarı yapılandırılmamış',
      });
    }

    requireMailCredentialEncryption();

    const tenantId = req.user!.tenantId;
    const {
      brand_id,
      name,
      email,
      company_name,
      imap_host,
      imap_port,
      imap_user,
      imap_password,
      imap_secure,
      smtp_host,
      smtp_port,
      smtp_user,
      smtp_password,
      smtp_secure,
      sender_display_name,
      reply_to,
      is_active,
      test_connection = true,
    } = req.body;

    const provider = normalizeProvider(req.body.provider);

    if (!brand_id || !email || !imap_host || !imap_user || !imap_password) {
      return badRequest(res, 'Marka, e-posta, IMAP host, kullanıcı adı ve parola zorunludur');
    }

    if (provider === 'gmail' || provider === 'outlook') {
      // Password/app-password flow only; OAuth UI is not enabled
    }

    const brand = await getOwnedBrand(Number(brand_id), tenantId);
    if (!brand) return notFound(res);

    const emailDomain = extractEmailDomain(String(email));
    if (!emailDomain) {
      return badRequest(res, 'Geçersiz e-posta adresi');
    }
    if (brand.domain) {
      const brandDomain = normalizeDomainInput(brand.domain);
      if (brandDomain.ok && brandDomain.domain !== emailDomain) {
        return badRequest(res, 'E-posta domaini marka alan adıyla uyuşmuyor');
      }
    }

    const domainReady = await isBrandDomainDeliverabilityValid(tenantId, Number(brand_id));
    const encryptedImapPassword = encryptCredential(imap_password);
    const smtpPassPlain =
      typeof smtp_password === 'string' && smtp_password.length > 0
        ? smtp_password
        : imap_password;
    const encryptedSmtpPassword = encryptCredential(smtpPassPlain);

    let testResult: Awaited<ReturnType<typeof testMailConnection>> | null = null;
    if (test_connection) {
      testResult = await testMailConnection({
        email,
        imap_host,
        imap_port: Number(imap_port) || 993,
        imap_user,
        imap_password,
        imap_secure: imap_secure !== false && imap_secure !== 'false',
        smtp_host: smtp_host || undefined,
        smtp_port: smtp_port ? Number(smtp_port) : 587,
        smtp_user: smtp_user || imap_user,
        smtp_password: smtpPassPlain,
        smtp_secure: Boolean(smtp_secure),
      });
    }

    const channelStatus = !test_connection
      ? 'NOT_CONFIGURED'
      : testResult?.success
        ? 'ACTIVE'
        : 'ERROR';

    const account = await withTransaction(async (client) => {
      const accountInsert = await client.query(
        `INSERT INTO mail_accounts
           (name, email, company_name, imap_host, imap_port, imap_user, imap_password, imap_secure,
            smtp_host, smtp_port, smtp_user, smtp_password, smtp_secure,
            tenant_id, is_active, provider, auth_type,
            imap_connection_status, smtp_connection_status, last_connection_test_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'password',$17,$18,$19)
         RETURNING id`,
        [
          name || email,
          email.trim(),
          company_name || brand.name,
          imap_host,
          imap_port || 993,
          imap_user,
          encryptedImapPassword,
          imap_secure !== false && imap_secure !== 'false',
          smtp_host || null,
          smtp_port || 587,
          smtp_user || imap_user,
          encryptedSmtpPassword,
          Boolean(smtp_secure),
          tenantId,
          is_active === false || is_active === 'false' ? false : true,
          provider,
          testResult ? (testResult.imap_ok ? 'ok' : 'error') : 'unknown',
          testResult ? (testResult.smtp_ok ? 'ok' : 'error') : 'unknown',
          testResult ? new Date() : null,
        ]
      );

      const accountId = accountInsert.rows[0].id;

      const connectionInsert = await client.query(
        `INSERT INTO channel_connections
           (tenant_id, brand_id, channel_type, provider, display_name, status, mail_account_id, settings, last_tested_at)
         VALUES ($1, $2, 'EMAIL', $3, $4, $5, $6, '{}'::jsonb, $7)
         RETURNING id`,
        [
          tenantId,
          Number(brand_id),
          provider,
          `${name || email} · E-posta`,
          channelStatus,
          accountId,
          testResult ? new Date() : null,
        ]
      );

      const connectionId = connectionInsert.rows[0].id;

      await client.query(
        `UPDATE sender_identities
         SET is_default = false, updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $1 AND brand_id = $2 AND channel_type = 'EMAIL' AND is_default = true`,
        [tenantId, Number(brand_id)]
      );

      await client.query(
        `INSERT INTO sender_identities
           (tenant_id, brand_id, channel_connection_id, channel_type, display_name, sender_value, reply_to,
            is_default, is_verified, is_active)
         VALUES ($1, $2, $3, 'EMAIL', $4, $5, $6, true, $7, true)`,
        [
          tenantId,
          Number(brand_id),
          connectionId,
          sender_display_name || name || email,
          email.trim(),
          reply_to || null,
          channelStatus === 'ACTIVE' && domainReady,
        ]
      );

      return accountId;
    });

    await trackUsage(tenantId, req.user!.userId, 'account_create', 'mail_account', account);
    await afterCountResourceCreated(tenantId);

    const detail = await fetchAccountDetail(account, tenantId);
    if (detail?.is_active !== false) {
      await publishMailAccountEvent({
        type: 'ACCOUNT_CREATED',
        tenantId,
        accountId: account,
      });
    }
    res.status(201).json(sanitizeMailAccount(detail));
  } catch (error: any) {
    if (error.message?.includes('MAIL_CREDENTIALS_ENCRYPTION_KEY')) {
      return res.status(503).json({ error: 'Hesap kaydı için şifreleme anahtarı yapılandırılmamış' });
    }
    console.error('Error creating account:', error.message || error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Bu e-posta hesabı zaten kayıtlı' });
    }
    res.status(500).json({ error: 'Hesap oluşturulamadı' });
  }
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const result = await query(
      `SELECT ${ACCOUNT_LIST_SELECT}
       FROM mail_accounts ma
       LEFT JOIN LATERAL (
         SELECT id, brand_id, status, last_tested_at
         FROM channel_connections
         WHERE mail_account_id = ma.id
           AND tenant_id = ma.tenant_id
           AND channel_type = 'EMAIL'
         ORDER BY id ASC
         LIMIT 1
       ) cc ON true
       LEFT JOIN brands b
         ON b.id = cc.brand_id AND b.tenant_id = ma.tenant_id
       LEFT JOIN LATERAL (
         SELECT id, display_name, reply_to
         FROM sender_identities
         WHERE channel_connection_id = cc.id
           AND tenant_id = ma.tenant_id
         ORDER BY is_default DESC, id ASC
         LIMIT 1
       ) si ON true
       WHERE ma.tenant_id = $1
       ORDER BY ma.created_at DESC`,
      [tenantId]
    );
    res.json(sanitizeMailAccounts(result.rows));
  } catch (error) {
    console.error('Error fetching accounts:', error);
    res.status(500).json({ error: 'Hesaplar alınamadı' });
  }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const detail = await fetchAccountDetail(Number(req.params.id), tenantId);
    if (!detail) return notFound(res);
    res.json(sanitizeMailAccount(detail));
  } catch (error) {
    console.error('Error fetching account:', error);
    res.status(500).json({ error: 'Hesap alınamadı' });
  }
});

router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    if (isProductionWithoutEncryptionKey()) {
      return res.status(503).json({
        error: 'Hesap güncellemesi için şifreleme anahtarı yapılandırılmamış',
      });
    }

    const { id } = req.params;
    const tenantId = req.user!.tenantId;
    const existing = await loadAccountForTenant(Number(id), tenantId);
    if (!existing) return notFound(res);

    const {
      brand_id,
      name,
      email,
      company_name,
      smtp_host,
      smtp_port,
      smtp_user,
      smtp_password,
      smtp_secure,
      imap_host,
      imap_port,
      imap_user,
      imap_password,
      imap_secure,
      sender_display_name,
      reply_to,
      is_active,
    } = req.body;

    if (brand_id !== undefined) {
      const brand = await getOwnedBrand(Number(brand_id), tenantId);
      if (!brand) return notFound(res);
    }

    if (email !== undefined && typeof email === 'string' && email.trim()) {
      // sender must stay in sync with real account email; no alias
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    const setField = (column: string, value: unknown) => {
      updates.push(`${column} = $${paramIndex++}`);
      values.push(value);
    };

    if (name !== undefined) setField('name', name);
    if (email !== undefined) setField('email', String(email).trim());
    if (company_name !== undefined) setField('company_name', company_name);
    if (smtp_host !== undefined) setField('smtp_host', smtp_host);
    if (smtp_port !== undefined) setField('smtp_port', smtp_port || 587);
    if (smtp_user !== undefined) setField('smtp_user', smtp_user);
    if (smtp_secure !== undefined) setField('smtp_secure', Boolean(smtp_secure));
    if (imap_host !== undefined) setField('imap_host', imap_host);
    if (imap_port !== undefined) setField('imap_port', imap_port || 993);
    if (imap_user !== undefined) setField('imap_user', imap_user);
    if (imap_secure !== undefined) {
      setField('imap_secure', imap_secure !== false && imap_secure !== 'false');
    }
    if (is_active !== undefined) setField('is_active', !(is_active === false || is_active === 'false'));
    if (req.body.provider !== undefined) setField('provider', normalizeProvider(req.body.provider));

    if (typeof smtp_password === 'string' && smtp_password.length > 0) {
      requireMailCredentialEncryption();
      setField('smtp_password', encryptCredential(smtp_password));
    }

    if (typeof imap_password === 'string' && imap_password.length > 0) {
      requireMailCredentialEncryption();
      setField('imap_password', encryptCredential(imap_password));
    }

    await withTransaction(async (client) => {
      if (updates.length > 0) {
        updates.push('updated_at = CURRENT_TIMESTAMP');
        values.push(id, tenantId);
        await client.query(
          `UPDATE mail_accounts
           SET ${updates.join(', ')}
           WHERE id = $${paramIndex++} AND tenant_id = $${paramIndex}`,
          values
        );
      }

      const link = await client.query(
        `SELECT id, brand_id FROM channel_connections
         WHERE mail_account_id = $1 AND tenant_id = $2 AND channel_type = 'EMAIL'
         ORDER BY id ASC LIMIT 1`,
        [id, tenantId]
      );

      let connectionId = link.rows[0]?.id as number | undefined;
      let connectionBrandId = link.rows[0]?.brand_id as number | undefined;

      if (brand_id !== undefined) {
        const nextBrandId = Number(brand_id);
        if (connectionId) {
          if (connectionBrandId !== nextBrandId) {
            await client.query(
              `UPDATE channel_connections
               SET brand_id = $1, updated_at = CURRENT_TIMESTAMP
               WHERE id = $2 AND tenant_id = $3`,
              [nextBrandId, connectionId, tenantId]
            );
            await client.query(
              `UPDATE sender_identities
               SET brand_id = $1, updated_at = CURRENT_TIMESTAMP
               WHERE channel_connection_id = $2 AND tenant_id = $3`,
              [nextBrandId, connectionId, tenantId]
            );
            connectionBrandId = nextBrandId;
          }
        } else {
          const brand = await getOwnedBrand(nextBrandId, tenantId);
          if (!brand) throw Object.assign(new Error('BRAND_NOT_FOUND'), { code: 'BRAND_NOT_FOUND' });

          const created = await client.query(
            `INSERT INTO channel_connections
               (tenant_id, brand_id, channel_type, provider, display_name, status, mail_account_id, settings)
             VALUES ($1, $2, 'EMAIL', $3, $4, 'NOT_CONFIGURED', $5, '{}'::jsonb)
             RETURNING id`,
            [
              tenantId,
              nextBrandId,
              normalizeProvider(existing.provider),
              `${existing.name || existing.email} · E-posta`,
              id,
            ]
          );
          connectionId = created.rows[0].id;
          connectionBrandId = nextBrandId;

          await client.query(
            `INSERT INTO sender_identities
               (tenant_id, brand_id, channel_connection_id, channel_type, display_name, sender_value, reply_to,
                is_default, is_verified, is_active)
             VALUES ($1, $2, $3, 'EMAIL', $4, $5, $6, true, false, true)`,
            [
              tenantId,
              nextBrandId,
              connectionId,
              sender_display_name || name || existing.name || existing.email,
              (email || existing.email).trim(),
              reply_to || null,
            ]
          );
        }
      }

      if (connectionId) {
        const nextEmail = (email !== undefined ? String(email).trim() : existing.email) as string;
        const senderUpdates: string[] = [];
        const senderValues: unknown[] = [];
        let sIdx = 1;

        senderUpdates.push(`sender_value = $${sIdx++}`);
        senderValues.push(nextEmail);

        if (sender_display_name !== undefined) {
          senderUpdates.push(`display_name = $${sIdx++}`);
          senderValues.push(sender_display_name);
        } else if (name !== undefined) {
          senderUpdates.push(`display_name = $${sIdx++}`);
          senderValues.push(name);
        }

        if (reply_to !== undefined) {
          senderUpdates.push(`reply_to = $${sIdx++}`);
          senderValues.push(reply_to || null);
        }

        senderUpdates.push('updated_at = CURRENT_TIMESTAMP');
        senderValues.push(connectionId, tenantId);

        await client.query(
          `UPDATE sender_identities
           SET ${senderUpdates.join(', ')}
           WHERE channel_connection_id = $${sIdx++}
             AND tenant_id = $${sIdx}
             AND channel_type = 'EMAIL'`,
          senderValues
        );
      }
    });

    await migrateLegacyCredentials(Number(id), tenantId);

    const detail = await fetchAccountDetail(Number(id), tenantId);
    if (!detail?.is_active) {
      await publishMailAccountEvent({
        type: 'ACCOUNT_DISABLED',
        tenantId,
        accountId: Number(id),
      });
    } else {
      await publishMailAccountEvent({
        type: 'ACCOUNT_UPDATED',
        tenantId,
        accountId: Number(id),
      });
    }
    res.json(sanitizeMailAccount(detail));
  } catch (error: any) {
    if (error.code === 'BRAND_NOT_FOUND') return notFound(res);
    if (error.message?.includes('MAIL_CREDENTIALS_ENCRYPTION_KEY')) {
      return res.status(503).json({ error: 'Hesap güncellemesi için şifreleme anahtarı yapılandırılmamış' });
    }
    console.error('Error updating account:', error.message || error);
    res.status(500).json({ error: 'Hesap güncellenemedi' });
  }
});

router.patch('/:id/toggle', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user!.tenantId;

    const result = await query(
      `UPDATE mail_accounts
       SET is_active = NOT is_active, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND tenant_id = $2
       RETURNING ${PUBLIC_MAIL_ACCOUNT_FIELDS}`,
      [id, tenantId]
    );

    if (result.rows.length === 0) {
      return notFound(res);
    }

    await query(
      `UPDATE channel_connections
       SET status = CASE WHEN $3 THEN 'ACTIVE' ELSE 'DISABLED' END,
           updated_at = CURRENT_TIMESTAMP
       WHERE mail_account_id = $1 AND tenant_id = $2 AND channel_type = 'EMAIL'`,
      [id, tenantId, result.rows[0].is_active]
    );

    await migrateLegacyCredentials(Number(id), tenantId);

    const detail = await fetchAccountDetail(Number(id), tenantId);
    await publishMailAccountEvent({
      type: result.rows[0].is_active ? 'ACCOUNT_UPDATED' : 'ACCOUNT_DISABLED',
      tenantId,
      accountId: Number(id),
    });
    res.json(sanitizeMailAccount(detail));
  } catch (error) {
    console.error('Error toggling account:', error);
    res.status(500).json({ error: 'Hesap durumu değiştirilemedi' });
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user!.tenantId;

    const existing = await loadAccountForTenant(Number(id), tenantId);
    if (!existing) return notFound(res);

    await withTransaction(async (client) => {
      const connections = await client.query(
        `SELECT id FROM channel_connections
         WHERE mail_account_id = $1 AND tenant_id = $2`,
        [id, tenantId]
      );

      const connectionIds = connections.rows.map((row: { id: number }) => row.id);
      if (connectionIds.length > 0) {
        await client.query(
          `DELETE FROM sender_identities
           WHERE tenant_id = $1 AND channel_connection_id = ANY($2::int[])`,
          [tenantId, connectionIds]
        );
        await client.query(
          `DELETE FROM channel_connections
           WHERE tenant_id = $1 AND id = ANY($2::int[])`,
          [tenantId, connectionIds]
        );
      }

      await client.query(`DELETE FROM mail_accounts WHERE id = $1 AND tenant_id = $2`, [
        id,
        tenantId,
      ]);
    });

    await publishMailAccountEvent({
      type: 'ACCOUNT_DELETED',
      tenantId,
      accountId: Number(id),
    });

    res.json({ message: 'Hesap silindi' });
  } catch (error) {
    console.error('Error deleting account:', error);
    res.status(500).json({ error: 'Hesap silinemedi' });
  }
});

export default router;
