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
import {
  compileEmailDocument,
  EditorDocument,
  hasRequiredBulkBlocks,
} from '../utils/emailBlockCompiler';
import { parseWhatsAppSettings } from '../whatsapp/whatsappCredentials';
import { isWhatsAppTemplateCategory } from '../utils/whatsappTemplateName';
import {
  safeTemplateSyncError,
  syncWhatsAppTemplatesForConnection,
} from '../services/whatsappTemplateSyncService';
import {
  listLibraryWithInstalls,
  refreshLibraryTemplate,
  submitReadyTemplate,
} from '../services/whatsappReadyTemplateLibraryService';
import { submitCustomWhatsAppTemplate } from '../services/whatsappCustomTemplateService';

const router = Router();
router.use(authenticate);

router.get('/', requirePermission('TEMPLATE_VIEW'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { brand_id, channel_type, q, channel_connection_id, approval_status } = req.query;
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

    // Scope WhatsApp templates to the selected connection's WABA
    if (channel_connection_id) {
      const connectionId = Number(channel_connection_id);
      if (!Number.isFinite(connectionId) || connectionId <= 0) {
        return badRequest(res, 'Geçersiz channel_connection_id');
      }
      const conn = await query(
        `SELECT id, brand_id, status, settings FROM channel_connections
         WHERE id = $1 AND tenant_id = $2 AND channel_type = 'WHATSAPP'`,
        [connectionId, tenantId]
      );
      if (!conn.rows[0]) return notFound(res, 'WhatsApp bağlantısı bulunamadı');
      if (String(conn.rows[0].status).toUpperCase() !== 'ACTIVE') {
        return badRequest(res, 'WhatsApp bağlantısı aktif değil');
      }
      let wabaId = '';
      try {
        wabaId = parseWhatsAppSettings(conn.rows[0].settings).wabaId;
      } catch {
        return badRequest(res, 'Bağlantıda waba_id eksik');
      }
      // Match templates already tagged with this WABA. Also include legacy Meta-synced
      // rows (provider_template_name set, provider_waba_id still NULL) that belong to
      // this brand/connection — do NOT invent fake local APPROVED templates.
      params.push(wabaId);
      const wabaParam = params.length;
      params.push(connectionId);
      const connParam = params.length;
      sql += ` AND (
        t.provider_waba_id = $${wabaParam}
        OR (
          t.provider_waba_id IS NULL
          AND NULLIF(TRIM(COALESCE(t.provider_template_name, '')), '') IS NOT NULL
          AND (t.channel_connection_id IS NULL OR t.channel_connection_id = $${connParam})
        )
      )`;
      if (brand_id && Number(brand_id) !== Number(conn.rows[0].brand_id)) {
        const { brandCanUseConnection } = await import(
          '../services/channelConnectionBrandShareService'
        );
        const allowed = await brandCanUseConnection(
          tenantId,
          Number(brand_id),
          connectionId
        );
        if (!allowed) {
          return badRequest(res, 'Şablon markası ile bağlantı markası uyuşmuyor');
        }
      }
    }

    if (approval_status) {
      params.push(String(approval_status).toUpperCase());
      sql += ` AND UPPER(COALESCE(t.provider_approval_status, '')) = $${params.length}`;
    }
    if (q && String(q).trim()) {
      params.push(`%${String(q).trim()}%`);
      sql += ` AND (t.name ILIKE $${params.length} OR t.subject ILIKE $${params.length})`;
    }

    sql += ' ORDER BY t.updated_at DESC NULLS LAST, t.created_at DESC';
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error listing templates:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch templates' });
  }
});

router.post('/compile', requirePermission('TEMPLATE_VIEW'), async (req: AuthRequest, res: Response) => {
  try {
    const doc = req.body.editor_json ?? req.body.editorJson;
    const subject = req.body.subject ?? '';
    const preheader = req.body.preheader ?? '';
    if (!doc || !doc.blocks) {
      return badRequest(res, 'editor_json with blocks is required');
    }
    const compiled = compileEmailDocument(doc as EditorDocument, { subject, preheader });
    res.json({ success: true, data: compiled });
  } catch (error) {
    console.error('Error compiling template:', error);
    res.status(500).json({ success: false, error: 'Şablon derlenemedi' });
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

/**
 * Ready template library — catalog is global; Meta installs are per WABA.
 * Routes must stay before /:id.
 */
router.get('/library', requirePermission('TEMPLATE_VIEW'), async (req: AuthRequest, res: Response) => {
  try {
    const brandId = req.query.brand_id ? Number(req.query.brand_id) : null;
    const connectionId = req.query.channel_connection_id
      ? Number(req.query.channel_connection_id)
      : req.query.channelConnectionId
        ? Number(req.query.channelConnectionId)
        : null;
    const data = await listLibraryWithInstalls({
      tenantId: req.user!.tenantId,
      brandId: brandId && Number.isFinite(brandId) ? brandId : null,
      connectionId: connectionId && Number.isFinite(connectionId) ? connectionId : null,
    });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error listing ready template library:', error);
    res.status(500).json({ success: false, error: 'Hazır şablon kütüphanesi yüklenemedi' });
  }
});

router.post(
  '/library/sync',
  requirePermission('TEMPLATE_MANAGE'),
  async (req: AuthRequest, res: Response) => {
    try {
      const connectionId = Number(
        req.body?.channelConnectionId || req.body?.channel_connection_id || ''
      );
      if (!connectionId || Number.isNaN(connectionId)) {
        return badRequest(res, 'WhatsApp hesabı (channelConnectionId) zorunludur');
      }
      const requestingBrandId = req.body?.brand_id
        ? Number(req.body.brand_id)
        : req.body?.brandId
          ? Number(req.body.brandId)
          : null;
      const result = await syncWhatsAppTemplatesForConnection({
        tenantId: req.user!.tenantId,
        connectionId,
        requestingBrandId:
          requestingBrandId && !Number.isNaN(requestingBrandId) ? requestingBrandId : null,
      });
      res.json({
        success: true,
        synced: result.synced,
        approved: result.approved,
      });
    } catch (err: any) {
      if (err.code === 'NOT_FOUND') return notFound(res);
      return badRequest(res, safeTemplateSyncError(err));
    }
  }
);

router.post(
  '/library/:key/submit',
  requirePermission('TEMPLATE_MANAGE'),
  async (req: AuthRequest, res: Response) => {
    try {
      const brandId = Number(req.body?.brand_id || req.body?.brandId || '');
      const connectionId = Number(
        req.body?.channelConnectionId || req.body?.channel_connection_id || ''
      );
      if (!brandId || Number.isNaN(brandId)) {
        return badRequest(res, 'Marka (brand_id) zorunludur');
      }
      if (!connectionId || Number.isNaN(connectionId)) {
        return badRequest(res, 'WhatsApp hesabı (channelConnectionId) zorunludur');
      }

      const result = await submitReadyTemplate({
        tenantId: req.user!.tenantId,
        userId: req.user!.userId,
        libraryKey: String(req.params.key || ''),
        brandId,
        connectionId,
        bodyText: req.body?.bodyText ?? req.body?.body_text ?? null,
        examples: Array.isArray(req.body?.examples) ? req.body.examples : null,
      });

      if (result.alreadyExists) {
        return res.status(200).json({
          success: true,
          alreadyExists: true,
          data: result.installation,
          message: result.message,
        });
      }

      await afterCountResourceCreatedSafe(req.user!.tenantId);
      res.status(201).json({
        success: true,
        alreadyExists: false,
        bodyCustomized: result.bodyCustomized,
        data: result.installation,
        message: result.message,
      });
    } catch (err: any) {
      if (err.code === 'NOT_FOUND') return notFound(res, err.message);
      if (
        err.code === 'NO_ACTIVE_CONNECTION' ||
        err.code === 'MISSING_CREDENTIALS' ||
        err.code === 'BAD_REQUEST' ||
        err.code === 'META_CREATE_FAILED'
      ) {
        // Prefer Meta user-facing fields already composed into err.message
        return badRequest(res, String(err.message || 'Şablon gönderilemedi'));
      }
      console.error('Ready template submit error');
      res.status(500).json({ success: false, error: 'Hazır şablon gönderilemedi' });
    }
  }
);

router.post(
  '/library/:key/refresh',
  requirePermission('TEMPLATE_MANAGE'),
  async (req: AuthRequest, res: Response) => {
    try {
      const brandId = Number(req.body?.brand_id || req.body?.brandId || '');
      const connectionId = Number(
        req.body?.channelConnectionId || req.body?.channel_connection_id || ''
      );
      if (!brandId || Number.isNaN(brandId)) {
        return badRequest(res, 'Marka (brand_id) zorunludur');
      }
      if (!connectionId || Number.isNaN(connectionId)) {
        return badRequest(res, 'WhatsApp hesabı (channelConnectionId) zorunludur');
      }
      const result = await refreshLibraryTemplate({
        tenantId: req.user!.tenantId,
        brandId,
        connectionId,
        libraryKey: String(req.params.key || ''),
      });
      res.json({
        success: true,
        synced: result.synced,
        approved: result.approved,
        data: result.installation,
      });
    } catch (err: any) {
      if (err.code === 'NOT_FOUND') return notFound(res, err.message);
      if (err.code === 'NO_ACTIVE_CONNECTION' || err.code === 'MISSING_CREDENTIALS') {
        return badRequest(res, String(err.message));
      }
      return badRequest(res, safeTemplateSyncError(err));
    }
  }
);

async function afterCountResourceCreatedSafe(tenantId: number) {
  try {
    const { afterCountResourceCreated } = await import('../utils/quotaGuards');
    await afterCountResourceCreated(tenantId);
  } catch {
    /* best-effort */
  }
}

function parseEditorJson(raw: unknown): EditorDocument | null {
  if (!raw || typeof raw !== 'object') return null;
  const doc = raw as EditorDocument;
  if (!Array.isArray(doc.blocks)) return null;
  return doc;
}

function buildContentFromBody(
  body: Record<string, unknown>,
  subject?: string | null
): {
  content: string
  plainText: string | null
  variables: string[]
  editorJson: EditorDocument | null
  warnings: string[]
} {
  const editorJson = parseEditorJson(body.editor_json ?? body.editorJson)
  if (!editorJson) {
    const rawVars = body.variables
    const variables = Array.isArray(rawVars)
      ? rawVars.map((v) => (typeof v === 'string' ? v : String((v as { name?: string })?.name || ''))).filter(Boolean)
      : []
    return {
      content: String(body.content || ''),
      plainText: body.plain_text_content ? String(body.plain_text_content) : null,
      variables,
      editorJson: null,
      warnings: [],
    }
  }
  const compiled = compileEmailDocument(editorJson, {
    subject: subject || String(body.subject || ''),
    preheader: String(body.preheader || ''),
  })
  return {
    content: compiled.html,
    plainText: compiled.plainText,
    variables: compiled.variables,
    editorJson,
    warnings: compiled.warnings,
  }
}

router.post('/', requirePermission('TEMPLATE_MANAGE'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { enforceCountQuota, afterCountResourceCreated } = await import('../utils/quotaGuards');
    if (!(await enforceCountQuota(res, tenantId, 'max_templates'))) return;
    const userId = req.user!.userId;
    const {
      name,
      content: bodyContent,
      is_shared = false,
      brand_id,
      channel_type,
      sender_identity_id,
      subject,
      plain_text_content,
      variables = [],
      is_active = true,
      description,
      preheader,
      editor_json,
      is_draft = true,
      template_kind = 'INDIVIDUAL',
      provider_template_name,
      provider_template_language,
      provider_approval_status,
      provider_template_components,
    } = req.body;

    const built = buildContentFromBody(req.body, subject);
    const content = built.content || bodyContent;
    if (!name || !content) {
      return badRequest(res, 'name and content are required');
    }

    const kind = String(template_kind || 'INDIVIDUAL').toUpperCase();
    if (!['INDIVIDUAL', 'BULK'].includes(kind)) {
      return badRequest(res, 'Invalid template_kind');
    }
    if (kind === 'BULK' && built.editorJson) {
      const reqBlocks = hasRequiredBulkBlocks(built.editorJson.blocks);
      if (!reqBlocks.company || !reqBlocks.unsubscribe) {
        return badRequest(res, 'Toplu gönderim şablonunda şirket bilgisi ve abonelikten çıkma bloğu gerekli');
      }
    }

    let finalChannelType = channel_type || null;
    if (finalChannelType && !isChannelType(finalChannelType)) {
      return badRequest(res, 'Invalid channel_type');
    }

    const isWhatsApp = String(finalChannelType || '').toUpperCase() === 'WHATSAPP';

    // WhatsApp: approval status is owned by Meta — ignore client-provided APPROVED/REJECTED.
    let approval = 'UNKNOWN';
    if (!isWhatsApp) {
      approval = String(provider_approval_status || 'UNKNOWN').toUpperCase();
      if (!['UNKNOWN', 'PENDING', 'APPROVED', 'REJECTED'].includes(approval)) {
        return badRequest(res, 'Invalid provider_approval_status');
      }
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

    const finalVariables =
      built.variables.length > 0
        ? built.variables
        : Array.isArray(variables)
          ? variables
          : [];

    let metaTemplateId: string | null = null;
    let metaCategory: string | null = null;
    let providerName: string | null = provider_template_name || null;
    let providerLanguage: string | null = provider_template_language || null;
    let componentsPayload: unknown = provider_template_components || [];
    let providerWabaId: string | null = null;
    let savedChannelConnectionId: number | null = null;

    if (String(finalChannelType || '').toUpperCase() === 'WHATSAPP') {
      if (!brand_id) {
        return badRequest(res, 'WhatsApp şablonu için marka (brand_id) zorunludur');
      }
      const channelConnectionId = Number(
        req.body?.channelConnectionId || req.body?.channel_connection_id || ''
      );
      if (!channelConnectionId || Number.isNaN(channelConnectionId)) {
        return badRequest(res, 'WhatsApp hesabı (channelConnectionId) zorunludur');
      }

      const categoryRaw = String(
        req.body?.category || req.body?.provider_template_category || ''
      ).trim();
      if (!isWhatsAppTemplateCategory(categoryRaw)) {
        return badRequest(
          res,
          'WhatsApp kategori zorunludur (UTILITY veya MARKETING)'
        );
      }

      const bodyText = String(
        built.plainText || plain_text_content || content || ''
      ).trim();

      const websiteButtonRaw = req.body?.website_button || req.body?.websiteButton;
      const websiteButton =
        websiteButtonRaw &&
        typeof websiteButtonRaw === 'object' &&
        String(websiteButtonRaw.text || '').trim() &&
        String(websiteButtonRaw.url || '').trim()
          ? {
              text: String(websiteButtonRaw.text).trim(),
              url: String(websiteButtonRaw.url).trim(),
            }
          : null;

      try {
        const created = await submitCustomWhatsAppTemplate({
          tenantId,
          userId,
          brandId: Number(brand_id),
          connectionId: channelConnectionId,
          displayName: String(name).trim(),
          bodyText,
          category: categoryRaw.toUpperCase(),
          language: String(provider_template_language || 'tr'),
          examples: Array.isArray(req.body?.examples) ? req.body.examples : null,
          variables: Array.isArray(req.body?.variables) ? req.body.variables : null,
          websiteButton,
          includeOptOutQuickReply: Boolean(
            req.body?.include_opt_out_quick_reply ?? req.body?.includeOptOutQuickReply
          ),
          providerTemplateName: provider_template_name || null,
        });
        await afterCountResourceCreated(tenantId);
        return res.status(201).json({
          success: true,
          data: created.template,
          message: created.message,
          providerName: created.providerName,
        });
      } catch (err: any) {
        if (err.code === 'NOT_FOUND') return notFound(res, err.message);
        if (
          err.code === 'NO_ACTIVE_CONNECTION' ||
          err.code === 'MISSING_CREDENTIALS' ||
          err.code === 'BAD_REQUEST' ||
          err.code === 'META_CREATE_FAILED'
        ) {
          return badRequest(res, String(err.message || 'WhatsApp şablonu oluşturulamadı'));
        }
        throw err;
      }
    }

    const result = await query(
      `INSERT INTO templates
        (name, content, tenant_id, created_by, is_shared, brand_id, channel_type,
         sender_identity_id, subject, plain_text_content, variables, is_active,
         description, preheader, editor_json, is_draft, template_kind,
         provider_template_name, provider_template_language, provider_approval_status,
         provider_template_components, provider_waba_id, channel_connection_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
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
        built.plainText || plain_text_content || null,
        JSON.stringify(finalVariables),
        Boolean(is_active),
        description || null,
        preheader || null,
        built.editorJson ? JSON.stringify(built.editorJson) : null,
        String(finalChannelType || '').toUpperCase() === 'WHATSAPP' ? false : Boolean(is_draft),
        kind,
        providerName,
        providerLanguage,
        approval,
        JSON.stringify(componentsPayload || []),
        providerWabaId,
        savedChannelConnectionId,
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
      `SELECT t.*, b.name AS brand_name
       FROM templates t
       LEFT JOIN brands b ON b.id = t.brand_id AND b.tenant_id = t.tenant_id
       WHERE t.id = $1 AND t.tenant_id = $2`,
      [req.params.id, req.user!.tenantId]
    );
    if (result.rows.length === 0) return notFound(res);
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error fetching template:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch template' });
  }
});

router.post('/:id/duplicate', requirePermission('TEMPLATE_MANAGE'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const { enforceCountQuota, afterCountResourceCreated } = await import('../utils/quotaGuards');
    if (!(await enforceCountQuota(res, tenantId, 'max_templates'))) return;

    const existing = await query(`SELECT * FROM templates WHERE id = $1 AND tenant_id = $2`, [
      req.params.id,
      tenantId,
    ]);
    if (existing.rows.length === 0) return notFound(res);
    const src = existing.rows[0];

    const result = await query(
      `INSERT INTO templates
        (name, content, tenant_id, created_by, is_shared, brand_id, channel_type,
         sender_identity_id, subject, plain_text_content, variables, is_active,
         description, preheader, editor_json, is_draft, template_kind,
         provider_template_name, provider_template_language, provider_approval_status,
         provider_template_components)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, true, $16, $17, $18, $19, $20)
       RETURNING *`,
      [
        `${src.name} (Kopya)`,
        src.content,
        tenantId,
        userId,
        src.is_shared,
        src.brand_id,
        src.channel_type,
        src.sender_identity_id,
        src.subject,
        src.plain_text_content,
        JSON.stringify(src.variables || []),
        false,
        src.description,
        src.preheader,
        src.editor_json ? JSON.stringify(src.editor_json) : null,
        src.template_kind || 'INDIVIDUAL',
        src.provider_template_name,
        src.provider_template_language,
        'UNKNOWN',
        JSON.stringify(src.provider_template_components || []),
      ]
    );
    await afterCountResourceCreated(tenantId);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error duplicating template:', error);
    res.status(500).json({ success: false, error: 'Şablon kopyalanamadı' });
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
    const body = req.body;
    const {
      name = current.name,
      content: bodyContent = current.content,
      is_shared = current.is_shared,
      brand_id = current.brand_id,
      channel_type = current.channel_type,
      sender_identity_id = current.sender_identity_id,
      subject = current.subject,
      plain_text_content = current.plain_text_content,
      variables = current.variables,
      is_active = current.is_active,
      description = current.description,
      preheader = current.preheader,
      editor_json = current.editor_json,
      is_draft = current.is_draft,
      template_kind = current.template_kind,
      provider_template_name = current.provider_template_name,
      provider_template_language = current.provider_template_language,
      provider_approval_status = current.provider_approval_status,
      provider_template_components = current.provider_template_components,
    } = body;

    const built = buildContentFromBody(
      { ...body, content: bodyContent, editor_json },
      subject
    );
    const content = built.content || bodyContent;

    const kind = String(template_kind || 'INDIVIDUAL').toUpperCase();
    if (!['INDIVIDUAL', 'BULK'].includes(kind)) {
      return badRequest(res, 'Invalid template_kind');
    }
    if (kind === 'BULK' && built.editorJson) {
      const reqBlocks = hasRequiredBulkBlocks(built.editorJson.blocks);
      if (!reqBlocks.company || !reqBlocks.unsubscribe) {
        return badRequest(res, 'Toplu gönderim şablonunda şirket bilgisi ve abonelikten çıkma bloğu gerekli');
      }
    }

    let finalChannelType = channel_type || null;
    if (finalChannelType && !isChannelType(finalChannelType)) {
      return badRequest(res, 'Invalid channel_type');
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

    // WhatsApp approval is Meta-owned; never accept client-set APPROVED/REJECTED on update.
    const approval =
      String(finalChannelType || '').toUpperCase() === 'WHATSAPP'
        ? String(current.provider_approval_status || 'PENDING').toUpperCase()
        : String(provider_approval_status || 'UNKNOWN').toUpperCase();
    if (!['UNKNOWN', 'PENDING', 'APPROVED', 'REJECTED'].includes(approval)) {
      return badRequest(res, 'Invalid provider_approval_status');
    }

    const subjectCheck = validateTemplateSubject(finalChannelType, subject);
    if (!subjectCheck.ok) {
      return badRequest(res, subjectCheck.error);
    }

    const finalVariables =
      built.variables.length > 0
        ? built.variables
        : Array.isArray(variables)
          ? variables
          : [];

    const result = await query(
      `UPDATE templates
       SET name = $1, content = $2, is_shared = $3, brand_id = $4, channel_type = $5,
           sender_identity_id = $6, subject = $7, plain_text_content = $8, variables = $9,
           is_active = $10,
           description = $11, preheader = $12, editor_json = $13, is_draft = $14, template_kind = $15,
           provider_template_name = $16,
           provider_template_language = $17,
           provider_approval_status = $18,
           provider_template_components = $19,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $20 AND tenant_id = $21
       RETURNING *`,
      [
        String(name).trim(),
        content,
        Boolean(is_shared),
        brand_id || null,
        finalChannelType,
        sender_identity_id || null,
        finalChannelType === 'EMAIL' ? subject || null : null,
        built.plainText || plain_text_content || null,
        JSON.stringify(finalVariables),
        Boolean(is_active),
        description || null,
        preheader || null,
        built.editorJson ? JSON.stringify(built.editorJson) : editor_json ? JSON.stringify(editor_json) : null,
        Boolean(is_draft),
        kind,
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
    const tenantId = req.user!.tenantId;
    const templateId = Number(req.params.id);

    const usage = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM outbound_messages WHERE template_id = $1 AND tenant_id = $2) AS outbound_count,
         (SELECT COUNT(*)::int FROM drafts WHERE template_id = $1 AND tenant_id = $2) AS draft_count`,
      [templateId, tenantId]
    );
    const outboundCount = Number(usage.rows[0]?.outbound_count || 0);
    const draftCount = Number(usage.rows[0]?.draft_count || 0);
    if (outboundCount > 0 || draftCount > 0) {
      return res.status(409).json({
        success: false,
        error: 'Şablon gönderim veya taslak kayıtlarında kullanılıyor; silinemez.',
        usage: { outboundCount, draftCount },
      });
    }

    const result = await query(
      `DELETE FROM templates WHERE id = $1 AND tenant_id = $2 RETURNING id`,
      [templateId, tenantId]
    );
    if (result.rows.length === 0) return notFound(res);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting template:', error);
    res.status(500).json({ success: false, error: 'Failed to delete template' });
  }
});

export default router;
