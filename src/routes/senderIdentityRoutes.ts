import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../permissions/requirePermission';
import { badRequest, conflict, notFound } from '../utils/channelPlatform';
import { evaluateSenderDomainPolicy } from '../utils/brandDeliverability';

const router = Router();
router.use(authenticate);

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { brand_id, channel_type, eligible_for_send } = req.query;
    const params: unknown[] = [tenantId];

    let sql = `
      SELECT si.*, b.name AS brand_name, cc.display_name AS connection_name, cc.status AS connection_status,
             cc.mail_account_id, ma.email AS mail_account_email, ma.is_active AS mail_account_active
      FROM sender_identities si
      JOIN brands b ON b.id = si.brand_id AND b.tenant_id = si.tenant_id
      JOIN channel_connections cc ON cc.id = si.channel_connection_id AND cc.tenant_id = si.tenant_id
      LEFT JOIN mail_accounts ma ON ma.id = cc.mail_account_id AND ma.tenant_id = si.tenant_id
      WHERE si.tenant_id = $1
    `;

    if (brand_id) {
      params.push(brand_id);
      sql += ` AND si.brand_id = $${params.length}`;
    }
    if (channel_type) {
      params.push(channel_type);
      sql += ` AND si.channel_type = $${params.length}`;
    }

    if (eligible_for_send === 'true' || eligible_for_send === '1') {
      sql += `
        AND si.channel_type = 'EMAIL'
        AND si.is_active = true
        AND si.is_verified = true
        AND cc.status = 'ACTIVE'
        AND cc.mail_account_id IS NOT NULL
        AND ma.is_active = true
        AND LOWER(si.sender_value) = LOWER(ma.email)
      `;
    }

    sql += ' ORDER BY si.created_at DESC';
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error listing sender identities:', error);
    res.status(500).json({ error: 'Failed to list sender identities' });
  }
});

router.post('/', requirePermission('SENDER_IDENTITY_MANAGE'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { enforceCountQuota, afterCountResourceCreated } = await import('../utils/quotaGuards');
    if (!(await enforceCountQuota(res, tenantId, 'max_sender_identities'))) return;
    const {
      brand_id,
      channel_connection_id,
      display_name,
      sender_value,
      reply_to,
      is_default = false,
      is_verified = false,
      is_active = true,
    } = req.body;

    if (!brand_id || !channel_connection_id || !display_name || !sender_value) {
      return badRequest(
        res,
        'brand_id, channel_connection_id, display_name and sender_value are required'
      );
    }

    const connectionResult = await query(
      `SELECT cc.id, cc.brand_id, cc.channel_type, cc.status, cc.mail_account_id, ma.email AS mail_account_email
       FROM channel_connections cc
       LEFT JOIN mail_accounts ma
         ON ma.id = cc.mail_account_id AND ma.tenant_id = cc.tenant_id
       WHERE cc.id = $1 AND cc.tenant_id = $2`,
      [channel_connection_id, tenantId]
    );
    if (connectionResult.rows.length === 0) return notFound(res);

    const connection = connectionResult.rows[0];
    const targetBrandId = Number(brand_id);
    if (Number(connection.brand_id) !== targetBrandId) {
      const { brandCanUseConnection } = await import(
        '../services/channelConnectionBrandShareService'
      );
      const allowed = await brandCanUseConnection(
        tenantId,
        targetBrandId,
        Number(channel_connection_id)
      );
      if (!allowed) {
        return badRequest(res, 'channel_connection_id does not belong to the selected brand');
      }
    }

    let resolvedSenderValue = String(sender_value).trim();
    if (connection.channel_type === 'EMAIL' && connection.mail_account_id) {
      if (!connection.mail_account_email) {
        return badRequest(res, 'Linked mail account was not found');
      }
      if (
        resolvedSenderValue.toLowerCase() !== String(connection.mail_account_email).toLowerCase()
      ) {
        return badRequest(
          res,
          'Sender value must match the linked mail account email address'
        );
      }
      resolvedSenderValue = String(connection.mail_account_email).trim();
    }

    const brandResult = await query(
      `SELECT id, domain FROM brands WHERE id = $1 AND tenant_id = $2`,
      [brand_id, tenantId]
    );
    if (brandResult.rows.length === 0) return notFound(res);

    let verifiedFlag = false;

    if (connection.channel_type === 'EMAIL') {
      const policy = await evaluateSenderDomainPolicy({
        tenantId,
        brandId: Number(brand_id),
        senderEmail: resolvedSenderValue,
      });
      if (!policy.ok) {
        if (policy.error === 'NOT_FOUND') return notFound(res);
        return badRequest(res, policy.error || 'Gönderici domain politikası başarısız');
      }
      // Client cannot force verified when domain health is not VALID
      verifiedFlag = Boolean(is_verified) && policy.canVerify;
    } else {
      verifiedFlag = Boolean(is_verified);
    }

    if (is_default) {
      await query(
        `UPDATE sender_identities
         SET is_default = false, updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $1 AND brand_id = $2 AND channel_type = $3 AND is_default = true`,
        [tenantId, brand_id, connection.channel_type]
      );
    }

    const result = await query(
      `INSERT INTO sender_identities
        (tenant_id, brand_id, channel_connection_id, channel_type, display_name,
         sender_value, reply_to, is_default, is_verified, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        tenantId,
        brand_id,
        channel_connection_id,
        connection.channel_type,
        String(display_name).trim(),
        resolvedSenderValue,
        reply_to || null,
        Boolean(is_default),
        verifiedFlag,
        Boolean(is_active),
      ]
    );

    await afterCountResourceCreated(tenantId);
    res.status(201).json(result.rows[0]);
  } catch (error: any) {
    if (error.code === '23505') {
      return conflict(res, 'Sender identity already exists for this connection');
    }
    console.error('Error creating sender identity:', error);
    res.status(500).json({ error: 'Failed to create sender identity' });
  }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT * FROM sender_identities WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.user!.tenantId]
    );
    if (result.rows.length === 0) return notFound(res);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching sender identity:', error);
    res.status(500).json({ error: 'Failed to fetch sender identity' });
  }
});

router.patch('/:id', requirePermission('SENDER_IDENTITY_MANAGE'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const existingResult = await query(
      `SELECT * FROM sender_identities WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId]
    );
    if (existingResult.rows.length === 0) return notFound(res);

    const current = existingResult.rows[0];
    const {
      display_name = current.display_name,
      sender_value = current.sender_value,
      reply_to = current.reply_to,
      is_default = current.is_default,
      is_verified = current.is_verified,
      is_active = current.is_active,
      channel_connection_id = current.channel_connection_id,
    } = req.body;

    // sender_value may change only within the same owned connection; connection change must stay tenant-owned
    const connectionResult = await query(
      `SELECT cc.id, cc.brand_id, cc.channel_type, cc.mail_account_id, ma.email AS mail_account_email
       FROM channel_connections cc
       LEFT JOIN mail_accounts ma
         ON ma.id = cc.mail_account_id AND ma.tenant_id = cc.tenant_id
       WHERE cc.id = $1 AND cc.tenant_id = $2`,
      [channel_connection_id, tenantId]
    );
    if (connectionResult.rows.length === 0) return notFound(res);

    const connection = connectionResult.rows[0];
    if (Number(connection.brand_id) !== Number(current.brand_id)) {
      return badRequest(res, 'Sender identity cannot move to another brand connection');
    }

    let resolvedSenderValue = String(sender_value).trim();
    if (connection.channel_type === 'EMAIL' && connection.mail_account_id) {
      if (!connection.mail_account_email) {
        return badRequest(res, 'Linked mail account was not found');
      }
      if (
        resolvedSenderValue.toLowerCase() !== String(connection.mail_account_email).toLowerCase()
      ) {
        return badRequest(
          res,
          'Sender value must match the linked mail account email address'
        );
      }
      resolvedSenderValue = String(connection.mail_account_email).trim();
    }

    let verifiedFlag = current.is_verified;
    if (connection.channel_type === 'EMAIL') {
      const policy = await evaluateSenderDomainPolicy({
        tenantId,
        brandId: Number(current.brand_id),
        senderEmail: resolvedSenderValue,
      });
      if (!policy.ok) {
        if (policy.error === 'NOT_FOUND') return notFound(res);
        return badRequest(res, policy.error || 'Gönderici domain politikası başarısız');
      }

      if (req.body.is_verified !== undefined) {
        if (Boolean(is_verified)) {
          // Keep existing verified; only newly grant when domain health is VALID
          verifiedFlag = Boolean(current.is_verified) || policy.canVerify;
        } else {
          verifiedFlag = false;
        }
      }
    } else if (req.body.is_verified !== undefined) {
      verifiedFlag = Boolean(is_verified);
    }

    if (is_default) {
      await query(
        `UPDATE sender_identities
         SET is_default = false, updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $1 AND brand_id = $2 AND channel_type = $3 AND is_default = true AND id <> $4`,
        [tenantId, current.brand_id, connection.channel_type, req.params.id]
      );
    }

    const result = await query(
      `UPDATE sender_identities
       SET channel_connection_id = $1, channel_type = $2, display_name = $3, sender_value = $4,
           reply_to = $5, is_default = $6, is_verified = $7, is_active = $8,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $9 AND tenant_id = $10
       RETURNING *`,
      [
        channel_connection_id,
        connection.channel_type,
        String(display_name).trim(),
        resolvedSenderValue,
        reply_to || null,
        Boolean(is_default),
        verifiedFlag,
        Boolean(is_active),
        req.params.id,
        tenantId,
      ]
    );

    res.json(result.rows[0]);
  } catch (error: any) {
    if (error.code === '23505') {
      return conflict(res, 'Sender identity already exists for this connection');
    }
    console.error('Error updating sender identity:', error);
    res.status(500).json({ error: 'Failed to update sender identity' });
  }
});

router.delete('/:id', requirePermission('SENDER_IDENTITY_MANAGE'), async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `DELETE FROM sender_identities WHERE id = $1 AND tenant_id = $2 RETURNING id`,
      [req.params.id, req.user!.tenantId]
    );
    if (result.rows.length === 0) return notFound(res);
    res.json({ message: 'Sender identity deleted successfully' });
  } catch (error) {
    console.error('Error deleting sender identity:', error);
    res.status(500).json({ error: 'Failed to delete sender identity' });
  }
});

export default router;
