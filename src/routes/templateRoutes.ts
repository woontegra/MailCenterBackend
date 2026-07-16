import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../permissions/requirePermission';
import {
  badRequest,
  isChannelType,
  notFound,
  validateTemplateSubject,
} from '../utils/channelPlatform';
import { renderTemplateContent } from '../utils/templateRenderer';

const router = Router();
router.use(authenticate);

router.get('/', requirePermission('TEMPLATE_VIEW'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { brand_id, channel_type } = req.query;
    const params: unknown[] = [tenantId];

    let sql = `
      SELECT t.*, b.name AS brand_name, si.display_name AS sender_display_name, si.sender_value
      FROM templates t
      LEFT JOIN brands b ON b.id = t.brand_id AND b.tenant_id = t.tenant_id
      LEFT JOIN sender_identities si ON si.id = t.sender_identity_id AND si.tenant_id = t.tenant_id
      WHERE t.tenant_id = $1
    `;

    if (brand_id) {
      params.push(brand_id);
      sql += ` AND t.brand_id = $${params.length}`;
    }
    if (channel_type) {
      if (!isChannelType(String(channel_type))) {
        return badRequest(res, 'Invalid channel_type');
      }
      params.push(channel_type);
      sql += ` AND t.channel_type = $${params.length}`;
    }

    sql += ' ORDER BY t.created_at DESC';
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error listing templates:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch templates' });
  }
});

router.post('/render', requirePermission('TEMPLATE_VIEW'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const templateId = req.body.templateId ?? req.body.template_id;
    let subject = req.body.subject ?? '';
    let htmlContent = req.body.htmlContent ?? req.body.content ?? '';
    let plainTextContent = req.body.plainTextContent ?? req.body.plain_text_content ?? '';
    let variables = req.body.variables ?? [];
    const values = req.body.templateVariables ?? req.body.values ?? {};

    if (templateId) {
      const template = await query(
        `SELECT id, subject, content, plain_text_content, variables
         FROM templates WHERE id = $1 AND tenant_id = $2`,
        [templateId, tenantId]
      );
      if (template.rows.length === 0) return notFound(res);
      const row = template.rows[0];
      if (!subject) subject = row.subject || '';
      if (!htmlContent) htmlContent = row.content || '';
      if (!plainTextContent) plainTextContent = row.plain_text_content || '';
      if (!variables || (Array.isArray(variables) && variables.length === 0)) {
        variables = row.variables || [];
      }
    }

    const rendered = renderTemplateContent({
      subject,
      htmlContent,
      plainTextContent,
      variables,
      values,
    });

    res.json({
      success: true,
      data: rendered,
      canSend: rendered.missingRequired.length === 0,
    });
  } catch (error) {
    console.error('Error rendering template:', error);
    res.status(500).json({ success: false, error: 'Şablon render edilemedi' });
  }
});

router.post('/', requirePermission('TEMPLATE_MANAGE'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { enforceCountQuota, afterCountResourceCreated } = await import('../utils/quotaGuards');
    if (!(await enforceCountQuota(res, tenantId, 'max_templates'))) return;
    const userId = req.user!.userId;
    const {
      name,
      content,
      is_shared = false,
      brand_id,
      channel_type,
      sender_identity_id,
      subject,
      plain_text_content,
      variables = [],
      is_active = true,
      provider_template_name,
      provider_template_language,
      provider_approval_status,
      provider_template_components,
    } = req.body;

    if (!name || !content) {
      return badRequest(res, 'name and content are required');
    }

    let finalChannelType = channel_type || null;
    if (finalChannelType && !isChannelType(finalChannelType)) {
      return badRequest(res, 'Invalid channel_type');
    }

    const approval = String(provider_approval_status || 'UNKNOWN').toUpperCase();
    if (!['UNKNOWN', 'PENDING', 'APPROVED', 'REJECTED'].includes(approval)) {
      return badRequest(res, 'Invalid provider_approval_status');
    }
    // Never auto-approve from client for WhatsApp without explicit APPROVED value from operator
    // (operator may set APPROVED only after Meta console confirmation)

    if (brand_id) {
      const brand = await query(`SELECT id FROM brands WHERE id = $1 AND tenant_id = $2`, [
        brand_id,
        tenantId,
      ]);
      if (brand.rows.length === 0) return notFound(res);
    }

    if (sender_identity_id) {
      const sender = await query(
        `SELECT id, brand_id, channel_type
         FROM sender_identities
         WHERE id = $1 AND tenant_id = $2`,
        [sender_identity_id, tenantId]
      );
      if (sender.rows.length === 0) return notFound(res);

      if (brand_id && Number(sender.rows[0].brand_id) !== Number(brand_id)) {
        return badRequest(res, 'sender_identity_id does not belong to the selected brand');
      }

      finalChannelType = sender.rows[0].channel_type;
    }

    const subjectCheck = validateTemplateSubject(finalChannelType, subject);
    if (!subjectCheck.ok) {
      return badRequest(res, subjectCheck.error);
    }

    const result = await query(
      `INSERT INTO templates
        (name, content, tenant_id, created_by, is_shared, brand_id, channel_type,
         sender_identity_id, subject, plain_text_content, variables, is_active,
         provider_template_name, provider_template_language, provider_approval_status,
         provider_template_components)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        String(name).trim(),
        content,
        tenantId,
        userId,
        Boolean(is_shared),
        brand_id || null,
        finalChannelType,
        sender_identity_id || null,
        finalChannelType === 'EMAIL' ? subject || null : null,
        plain_text_content || null,
        JSON.stringify(variables || []),
        Boolean(is_active),
        provider_template_name || null,
        provider_template_language || null,
        approval,
        JSON.stringify(provider_template_components || []),
      ]
    );

    await afterCountResourceCreated(tenantId);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error creating template:', error);
    res.status(500).json({ success: false, error: 'Failed to create template' });
  }
});

router.get('/:id', requirePermission('TEMPLATE_VIEW'), async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT * FROM templates WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.user!.tenantId]
    );
    if (result.rows.length === 0) return notFound(res);
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error fetching template:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch template' });
  }
});

router.patch('/:id', requirePermission('TEMPLATE_MANAGE'), async (req: AuthRequest, res: Response) => {
  await updateTemplate(req, res);
});

router.put('/:id', requirePermission('TEMPLATE_MANAGE'), async (req: AuthRequest, res: Response) => {
  await updateTemplate(req, res);
});

async function updateTemplate(req: AuthRequest, res: Response) {
  try {
    const tenantId = req.user!.tenantId;
    const existingResult = await query(
      `SELECT * FROM templates WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId]
    );
    if (existingResult.rows.length === 0) return notFound(res);

    const current = existingResult.rows[0];
    const {
      name = current.name,
      content = current.content,
      is_shared = current.is_shared,
      brand_id = current.brand_id,
      channel_type = current.channel_type,
      sender_identity_id = current.sender_identity_id,
      subject = current.subject,
      plain_text_content = current.plain_text_content,
      variables = current.variables,
      is_active = current.is_active,
      provider_template_name = current.provider_template_name,
      provider_template_language = current.provider_template_language,
      provider_approval_status = current.provider_approval_status,
      provider_template_components = current.provider_template_components,
    } = req.body;

    let finalChannelType = channel_type || null;
    if (finalChannelType && !isChannelType(finalChannelType)) {
      return badRequest(res, 'Invalid channel_type');
    }

    const approval = String(provider_approval_status || 'UNKNOWN').toUpperCase();
    if (!['UNKNOWN', 'PENDING', 'APPROVED', 'REJECTED'].includes(approval)) {
      return badRequest(res, 'Invalid provider_approval_status');
    }

    if (brand_id) {
      const brand = await query(`SELECT id FROM brands WHERE id = $1 AND tenant_id = $2`, [
        brand_id,
        tenantId,
      ]);
      if (brand.rows.length === 0) return notFound(res);
    }

    if (sender_identity_id) {
      const sender = await query(
        `SELECT id, brand_id, channel_type
         FROM sender_identities
         WHERE id = $1 AND tenant_id = $2`,
        [sender_identity_id, tenantId]
      );
      if (sender.rows.length === 0) return notFound(res);
      if (brand_id && Number(sender.rows[0].brand_id) !== Number(brand_id)) {
        return badRequest(res, 'sender_identity_id does not belong to the selected brand');
      }
      finalChannelType = sender.rows[0].channel_type;
    }

    const subjectCheck = validateTemplateSubject(finalChannelType, subject);
    if (!subjectCheck.ok) {
      return badRequest(res, subjectCheck.error);
    }

    const result = await query(
      `UPDATE templates
       SET name = $1, content = $2, is_shared = $3, brand_id = $4, channel_type = $5,
           sender_identity_id = $6, subject = $7, plain_text_content = $8, variables = $9,
           is_active = $10,
           provider_template_name = $11,
           provider_template_language = $12,
           provider_approval_status = $13,
           provider_template_components = $14,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $15 AND tenant_id = $16
       RETURNING *`,
      [
        String(name).trim(),
        content,
        Boolean(is_shared),
        brand_id || null,
        finalChannelType,
        sender_identity_id || null,
        finalChannelType === 'EMAIL' ? subject || null : null,
        plain_text_content || null,
        JSON.stringify(variables || []),
        Boolean(is_active),
        provider_template_name || null,
        provider_template_language || null,
        approval,
        JSON.stringify(provider_template_components || []),
        req.params.id,
        tenantId,
      ]
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error updating template:', error);
    res.status(500).json({ success: false, error: 'Failed to update template' });
  }
}

router.delete('/:id', requirePermission('TEMPLATE_MANAGE'), async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `DELETE FROM templates WHERE id = $1 AND tenant_id = $2 RETURNING id`,
      [req.params.id, req.user!.tenantId]
    );
    if (result.rows.length === 0) return notFound(res);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting template:', error);
    res.status(500).json({ success: false, error: 'Failed to delete template' });
  }
});

export default router;
