import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';
import { badRequest, notFound } from '../utils/channelPlatform';

const router = Router();

function draftSelectSql() {
  return `
    SELECT
      d.*,
      b.name AS brand_name,
      b.accent_color AS brand_accent_color,
      si.display_name AS sender_display_name,
      si.sender_value AS sender_value,
      t.name AS template_name
    FROM drafts d
    LEFT JOIN brands b ON b.id = d.brand_id AND b.tenant_id = d.tenant_id
    LEFT JOIN sender_identities si ON si.id = d.sender_identity_id AND si.tenant_id = d.tenant_id
    LEFT JOIN templates t ON t.id = d.template_id AND t.tenant_id = d.tenant_id
  `;
}

router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `${draftSelectSql()}
       WHERE d.user_id = $1 AND d.tenant_id = $2 AND COALESCE(d.status, 'draft') <> 'deleted'
       ORDER BY d.updated_at DESC`,
      [req.user!.userId, req.user!.tenantId]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error fetching drafts:', error);
    res.status(500).json({ success: false, error: 'Taslaklar alınamadı' });
  }
});

router.get('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `${draftSelectSql()}
       WHERE d.id = $1 AND d.user_id = $2 AND d.tenant_id = $3
         AND COALESCE(d.status, 'draft') <> 'deleted'`,
      [req.params.id, req.user!.userId, req.user!.tenantId]
    );
    if (result.rows.length === 0) return notFound(res);
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error fetching draft:', error);
    res.status(500).json({ success: false, error: 'Taslak alınamadı' });
  }
});

async function validateDraftRelations(
  tenantId: number,
  payload: {
    brand_id?: number | null;
    sender_identity_id?: number | null;
    template_id?: number | null;
  }
) {
  if (payload.brand_id) {
    const brand = await query(`SELECT id FROM brands WHERE id = $1 AND tenant_id = $2`, [
      payload.brand_id,
      tenantId,
    ]);
    if (brand.rows.length === 0) return { ok: false as const, notFound: true };
  }

  if (payload.sender_identity_id) {
    const sender = await query(
      `SELECT id, brand_id FROM sender_identities WHERE id = $1 AND tenant_id = $2`,
      [payload.sender_identity_id, tenantId]
    );
    if (sender.rows.length === 0) return { ok: false as const, notFound: true };
    if (
      payload.brand_id &&
      Number(sender.rows[0].brand_id) !== Number(payload.brand_id)
    ) {
      return { ok: false as const, badRequest: 'Gönderici seçilen markaya ait değil' };
    }
  }

  if (payload.template_id) {
    const template = await query(
      `SELECT id, brand_id FROM templates WHERE id = $1 AND tenant_id = $2`,
      [payload.template_id, tenantId]
    );
    if (template.rows.length === 0) return { ok: false as const, notFound: true };
    if (
      payload.brand_id &&
      template.rows[0].brand_id &&
      Number(template.rows[0].brand_id) !== Number(payload.brand_id)
    ) {
      return { ok: false as const, badRequest: 'Şablon seçilen markaya ait değil' };
    }
  }

  return { ok: true as const };
}

function mapDraftBody(body: any) {
  const to_address = body.to_address ?? body.to ?? null;
  const cc_address = body.cc_address ?? body.cc ?? null;
  const bcc_address = body.bcc_address ?? body.bcc ?? null;
  const html_content = body.html_content ?? body.htmlContent ?? body.body ?? null;
  const plain_text_content =
    body.plain_text_content ?? body.plainTextContent ?? body.text ?? null;
  const template_variables =
    body.template_variables ?? body.templateVariables ?? {};

  return {
    account_id: body.account_id ?? null,
    brand_id: body.brand_id ?? body.brandId ?? null,
    channel_type: body.channel_type ?? body.channelType ?? 'EMAIL',
    sender_identity_id: body.sender_identity_id ?? body.senderIdentityId ?? null,
    template_id: body.template_id ?? body.templateId ?? null,
    to_address,
    cc_address,
    bcc_address,
    subject: body.subject ?? null,
    body: plain_text_content || html_content || body.body || null,
    html_content,
    plain_text_content,
    template_variables,
    reply_to: body.reply_to ?? body.replyTo ?? null,
    status: body.status || 'draft',
    attachments: body.attachments || [],
  };
}

router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const data = mapDraftBody(req.body);

    const relationCheck = await validateDraftRelations(tenantId, data);
    if (!relationCheck.ok) {
      if (relationCheck.notFound) return notFound(res);
      return badRequest(res, relationCheck.badRequest || 'Geçersiz taslak verisi');
    }

    const result = await query(
      `INSERT INTO drafts (
         user_id, tenant_id, account_id, brand_id, channel_type, sender_identity_id, template_id,
         to_address, cc_address, bcc_address, subject, body, html_content, plain_text_content,
         template_variables, reply_to, status, attachments
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18::jsonb
       ) RETURNING *`,
      [
        userId,
        tenantId,
        data.account_id,
        data.brand_id,
        data.channel_type,
        data.sender_identity_id,
        data.template_id,
        data.to_address,
        data.cc_address,
        data.bcc_address,
        data.subject,
        data.body,
        data.html_content,
        data.plain_text_content,
        JSON.stringify(data.template_variables || {}),
        data.reply_to,
        data.status === 'sent' ? 'draft' : 'draft',
        JSON.stringify(data.attachments || []),
      ]
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error creating draft:', error);
    res.status(500).json({ success: false, error: 'Taslak oluşturulamadı' });
  }
});

router.patch('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  await updateDraft(req, res);
});

router.put('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  await updateDraft(req, res);
});

async function updateDraft(req: AuthRequest, res: Response) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const existing = await query(
      `SELECT * FROM drafts
       WHERE id = $1 AND user_id = $2 AND tenant_id = $3
         AND COALESCE(status, 'draft') <> 'deleted'`,
      [req.params.id, userId, tenantId]
    );
    if (existing.rows.length === 0) return notFound(res);

    const current = existing.rows[0];
    const data = mapDraftBody({ ...current, ...req.body });

    const relationCheck = await validateDraftRelations(tenantId, data);
    if (!relationCheck.ok) {
      if (relationCheck.notFound) return notFound(res);
      return badRequest(res, relationCheck.badRequest || 'Geçersiz taslak verisi');
    }

    const result = await query(
      `UPDATE drafts SET
         account_id = $1,
         brand_id = $2,
         channel_type = $3,
         sender_identity_id = $4,
         template_id = $5,
         to_address = $6,
         cc_address = $7,
         bcc_address = $8,
         subject = $9,
         body = $10,
         html_content = $11,
         plain_text_content = $12,
         template_variables = $13::jsonb,
         reply_to = $14,
         status = COALESCE($15, status, 'draft'),
         attachments = $16::jsonb,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $17 AND user_id = $18 AND tenant_id = $19
       RETURNING *`,
      [
        data.account_id,
        data.brand_id,
        data.channel_type,
        data.sender_identity_id,
        data.template_id,
        data.to_address,
        data.cc_address,
        data.bcc_address,
        data.subject,
        data.body,
        data.html_content,
        data.plain_text_content,
        JSON.stringify(data.template_variables || {}),
        data.reply_to,
        req.body.status && ['draft', 'sent'].includes(req.body.status)
          ? req.body.status
          : current.status || 'draft',
        JSON.stringify(data.attachments || []),
        req.params.id,
        userId,
        tenantId,
      ]
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error updating draft:', error);
    res.status(500).json({ success: false, error: 'Taslak güncellenemedi' });
  }
}

router.delete('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `DELETE FROM drafts
       WHERE id = $1 AND user_id = $2 AND tenant_id = $3
       RETURNING id`,
      [req.params.id, req.user!.userId, req.user!.tenantId]
    );
    if (result.rows.length === 0) return notFound(res);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting draft:', error);
    res.status(500).json({ success: false, error: 'Taslak silinemedi' });
  }
});

export default router;
