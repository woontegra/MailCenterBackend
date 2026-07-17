import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { query } from '../config/database';
import { badRequest, notFound } from '../utils/channelPlatform';
import {
  CONTACT_DISPLAY_NAME_SQL,
  getOwnedConversation,
  isConversationPriority,
  isConversationStatus,
  markConversationRead,
  sanitizeConversationRow,
  sanitizeNoteContent,
} from '../services/conversationService';
import {
  getConversationTimeline,
  previewFromTimeline,
} from '../services/conversationTimelineService';
import { requirePermission } from '../permissions/requirePermission';

const router = Router();
router.use(authenticate);
router.use(requirePermission('CONVERSATION_VIEW'));
router.use(async (req: AuthRequest, res: Response, next) => {
  try {
    const { enforceFeature } = await import('../utils/quotaGuards');
    if (!(await enforceFeature(res, req.user!.tenantId, 'unified_inbox'))) return;
    next();
  } catch (error) {
    next(error);
  }
});

function rejectTenantIdInjection(req: AuthRequest, res: Response): boolean {
  if (
    req.body?.tenantId != null ||
    req.body?.tenant_id != null ||
    req.query?.tenantId != null ||
    req.query?.tenant_id != null
  ) {
    badRequest(res, 'tenantId request üzerinden kabul edilmez');
    return true;
  }
  return false;
}

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    if (rejectTenantIdInjection(req, res)) return;
    const tenantId = req.user!.tenantId;

    const channel = req.query.channel ? String(req.query.channel).toUpperCase() : null;
    const brandId = req.query.brandId || req.query.brand_id
      ? Number(req.query.brandId || req.query.brand_id)
      : null;
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    const priority = req.query.priority ? String(req.query.priority).toUpperCase() : null;
    const assignedUserId =
      req.query.assignedUserId || req.query.assigned_user_id
        ? Number(req.query.assignedUserId || req.query.assigned_user_id)
        : null;
    const unreadOnly =
      String(req.query.unread || req.query.unreadOnly || '') === '1' ||
      String(req.query.unread || '').toLowerCase() === 'true';
    const contactId = req.query.contactId || req.query.contact_id
      ? Number(req.query.contactId || req.query.contact_id)
      : null;
    const q = req.query.q ? String(req.query.q).trim().slice(0, 200) : '';
    const fromDate = req.query.from || req.query.dateFrom
      ? new Date(String(req.query.from || req.query.dateFrom))
      : null;
    const toDate = req.query.to || req.query.dateTo
      ? new Date(String(req.query.to || req.query.dateTo))
      : null;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const offset = (page - 1) * limit;

    const clauses: string[] = ['c.tenant_id = $1'];
    const params: any[] = [tenantId];
    let i = 2;

    if (channel && ['EMAIL', 'SMS', 'WHATSAPP'].includes(channel)) {
      clauses.push(`c.channel_type = $${i++}`);
      params.push(channel);
    }
    if (brandId && Number.isFinite(brandId)) {
      clauses.push(`c.brand_id = $${i++}`);
      params.push(brandId);
    }
    if (status && isConversationStatus(status)) {
      clauses.push(`c.status = $${i++}`);
      params.push(status);
    } else if (String(req.query.archived || '') === '1') {
      clauses.push(`c.status = 'ARCHIVED'`);
    } else if (String(req.query.waiting || '') === '1') {
      clauses.push(`c.status = 'WAITING_REPLY'`);
    } else if (!status) {
      clauses.push(`c.status <> 'ARCHIVED'`);
    }
    if (priority && isConversationPriority(priority)) {
      clauses.push(`c.priority = $${i++}`);
      params.push(priority);
    }
    if (assignedUserId && Number.isFinite(assignedUserId)) {
      clauses.push(`c.assigned_user_id = $${i++}`);
      params.push(assignedUserId);
    }
    if (unreadOnly) {
      clauses.push(`c.unread_count > 0`);
    }
    if (contactId && Number.isFinite(contactId)) {
      clauses.push(`c.contact_id = $${i++}`);
      params.push(contactId);
    }
    if (q) {
      clauses.push(
        `(c.subject ILIKE $${i} OR c.participant_value ILIKE $${i} OR c.normalized_participant_value ILIKE $${i})`
      );
      params.push(`%${q.replace(/[%_]/g, '')}%`);
      i += 1;
    }
    if (fromDate && !Number.isNaN(fromDate.getTime())) {
      clauses.push(`c.last_message_at >= $${i++}`);
      params.push(fromDate);
    }
    if (toDate && !Number.isNaN(toDate.getTime())) {
      clauses.push(`c.last_message_at <= $${i++}`);
      params.push(toDate);
    }

    const where = clauses.join(' AND ');
    const countResult = await query(
      `SELECT COUNT(*)::int AS total FROM conversations c WHERE ${where}`,
      params
    );

    const listParams = [...params, limit, offset];
    const result = await query(
      `SELECT c.*,
              b.name AS brand_name,
              b.accent_color AS brand_accent_color,
              ${CONTACT_DISPLAY_NAME_SQL} AS contact_display_name,
              u.name AS assigned_user_name,
              u.email AS assigned_user_email
       FROM conversations c
       LEFT JOIN brands b ON b.id = c.brand_id AND b.tenant_id = c.tenant_id
       LEFT JOIN contacts ct ON ct.id = c.contact_id AND ct.tenant_id = c.tenant_id
       LEFT JOIN users u ON u.id = c.assigned_user_id AND u.tenant_id = c.tenant_id
       WHERE ${where}
       ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
       LIMIT $${i++} OFFSET $${i++}`,
      listParams
    );

    res.json({
      success: true,
      data: result.rows.map(sanitizeConversationRow),
      pagination: {
        page,
        limit,
        total: countResult.rows[0]?.total || 0,
      },
    });
  } catch (error) {
    console.error('Error listing conversations:', error);
    res.status(500).json({ success: false, error: 'Konuşmalar alınamadı' });
  }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    if (rejectTenantIdInjection(req, res)) return;
    const conv = await getOwnedConversation(Number(req.params.id), req.user!.tenantId);
    if (!conv) return notFound(res);

    const timeline = await getConversationTimeline({
      conversationId: conv.id,
      tenantId: req.user!.tenantId,
      channelType: conv.channel_type || 'EMAIL',
    });

    res.json({
      success: true,
      data: {
        ...sanitizeConversationRow(conv),
        last_message_preview: previewFromTimeline(timeline),
      },
    });
  } catch (error) {
    console.error('Error fetching conversation:', error);
    res.status(500).json({ success: false, error: 'Konuşma alınamadı' });
  }
});

router.get('/:id/messages', async (req: AuthRequest, res: Response) => {
  try {
    if (rejectTenantIdInjection(req, res)) return;
    const conv = await getOwnedConversation(Number(req.params.id), req.user!.tenantId);
    if (!conv) return notFound(res);

    const data = await getConversationTimeline({
      conversationId: conv.id,
      tenantId: req.user!.tenantId,
      channelType: conv.channel_type || 'EMAIL',
    });

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching conversation messages:', error);
    res.status(500).json({ success: false, error: 'Mesajlar alınamadı' });
  }
});

router.patch('/:id/status', async (req: AuthRequest, res: Response) => {
  try {
    if (rejectTenantIdInjection(req, res)) return;
    const status = String(req.body.status || '').toUpperCase();
    if (!isConversationStatus(status)) return badRequest(res, 'Geçersiz durum');

    const conv = await getOwnedConversation(Number(req.params.id), req.user!.tenantId);
    if (!conv) return notFound(res);

    const result = await query(
      `UPDATE conversations
       SET status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND tenant_id = $3
       RETURNING id`,
      [status, conv.id, req.user!.tenantId]
    );
    if (!result.rows[0]) return notFound(res);

    const updated = await getOwnedConversation(conv.id, req.user!.tenantId);
    try {
      const { emitAutomationEvent } = await import('../services/automationEmitter');
      await emitAutomationEvent({
        tenantId: req.user!.tenantId,
        triggerType: 'CONVERSATION_STATUS_CHANGED',
        triggerEventId: `conversation:${conv.id}:status:${status}`,
        payload: {
          conversationId: conv.id,
          brandId: updated?.brand_id,
          channel: updated?.channel_type,
          contactId: updated?.contact_id,
          conversationStatus: status,
          conversationPriority: updated?.priority,
          status,
        },
      });
    } catch {
      /* non-fatal */
    }
    res.json({ success: true, data: sanitizeConversationRow(updated) });
  } catch (error) {
    console.error('Error updating conversation status:', error);
    res.status(500).json({ success: false, error: 'Durum güncellenemedi' });
  }
});

router.patch('/:id/priority', async (req: AuthRequest, res: Response) => {
  try {
    if (rejectTenantIdInjection(req, res)) return;
    const priority = String(req.body.priority || '').toUpperCase();
    if (!isConversationPriority(priority)) return badRequest(res, 'Geçersiz öncelik');

    const conv = await getOwnedConversation(Number(req.params.id), req.user!.tenantId);
    if (!conv) return notFound(res);

    await query(
      `UPDATE conversations
       SET priority = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND tenant_id = $3`,
      [priority, conv.id, req.user!.tenantId]
    );
    const updated = await getOwnedConversation(conv.id, req.user!.tenantId);
    res.json({ success: true, data: sanitizeConversationRow(updated) });
  } catch (error) {
    console.error('Error updating conversation priority:', error);
    res.status(500).json({ success: false, error: 'Öncelik güncellenemedi' });
  }
});

router.patch('/:id/assignment', requirePermission('CONVERSATION_ASSIGN'), async (req: AuthRequest, res: Response) => {
  try {
    if (rejectTenantIdInjection(req, res)) return;
    const conv = await getOwnedConversation(Number(req.params.id), req.user!.tenantId);
    if (!conv) return notFound(res);

    const assignedRaw = req.body.assignedUserId ?? req.body.assigned_user_id;
    let assignedUserId: number | null = null;
    if (assignedRaw != null && assignedRaw !== '') {
      assignedUserId = Number(assignedRaw);
      if (!Number.isFinite(assignedUserId)) return badRequest(res, 'Geçersiz kullanıcı');
      const user = await query(
        `SELECT id FROM users WHERE id = $1 AND tenant_id = $2 AND COALESCE(is_active, true) = true`,
        [assignedUserId, req.user!.tenantId]
      );
      if (!user.rows[0]) return notFound(res);
    }

    await query(
      `UPDATE conversations
       SET assigned_user_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND tenant_id = $3`,
      [assignedUserId, conv.id, req.user!.tenantId]
    );
    const updated = await getOwnedConversation(conv.id, req.user!.tenantId);
    res.json({ success: true, data: sanitizeConversationRow(updated) });
  } catch (error) {
    console.error('Error updating conversation assignment:', error);
    res.status(500).json({ success: false, error: 'Atama güncellenemedi' });
  }
});

router.patch('/:id/contact', async (req: AuthRequest, res: Response) => {
  try {
    if (rejectTenantIdInjection(req, res)) return;
    const conv = await getOwnedConversation(Number(req.params.id), req.user!.tenantId);
    if (!conv) return notFound(res);

    const contactId = Number(req.body.contactId ?? req.body.contact_id);
    if (!Number.isFinite(contactId)) return badRequest(res, 'contactId gerekli');

    const contact = await query(
      `SELECT id FROM contacts WHERE id = $1 AND tenant_id = $2`,
      [contactId, req.user!.tenantId]
    );
    if (!contact.rows[0]) return notFound(res);

    await query(
      `UPDATE conversations
       SET contact_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND tenant_id = $3`,
      [contactId, conv.id, req.user!.tenantId]
    );
    const updated = await getOwnedConversation(conv.id, req.user!.tenantId);
    res.json({ success: true, data: sanitizeConversationRow(updated) });
  } catch (error) {
    console.error('Error linking conversation contact:', error);
    res.status(500).json({ success: false, error: 'Kişi bağlanamadı' });
  }
});

router.post('/:id/notes', requirePermission('INTERNAL_NOTE_CREATE'), async (req: AuthRequest, res: Response) => {
  try {
    if (rejectTenantIdInjection(req, res)) return;
    const conv = await getOwnedConversation(Number(req.params.id), req.user!.tenantId);
    if (!conv) return notFound(res);

    const content = sanitizeNoteContent(String(req.body.content || ''));
    if (!content) return badRequest(res, 'Not içeriği gerekli');

    const result = await query(
      `INSERT INTO conversation_notes (tenant_id, conversation_id, user_id, content)
       VALUES ($1, $2, $3, $4)
       RETURNING id, conversation_id, user_id, content, created_at`,
      [req.user!.tenantId, conv.id, req.user!.userId, content]
    );

    const user = await query(`SELECT name, email FROM users WHERE id = $1`, [req.user!.userId]);
    res.status(201).json({
      success: true,
      data: {
        ...result.rows[0],
        user_name: user.rows[0]?.name || null,
        user_email: user.rows[0]?.email || null,
      },
    });
  } catch (error) {
    console.error('Error creating conversation note:', error);
    res.status(500).json({ success: false, error: 'Not eklenemedi' });
  }
});

router.get('/:id/notes', async (req: AuthRequest, res: Response) => {
  try {
    if (rejectTenantIdInjection(req, res)) return;
    const conv = await getOwnedConversation(Number(req.params.id), req.user!.tenantId);
    if (!conv) return notFound(res);

    const result = await query(
      `SELECT n.id, n.conversation_id, n.user_id, n.content, n.created_at,
              u.name AS user_name, u.email AS user_email
       FROM conversation_notes n
       LEFT JOIN users u ON u.id = n.user_id AND u.tenant_id = n.tenant_id
       WHERE n.conversation_id = $1 AND n.tenant_id = $2
       ORDER BY n.created_at DESC`,
      [conv.id, req.user!.tenantId]
    );

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error listing conversation notes:', error);
    res.status(500).json({ success: false, error: 'Notlar alınamadı' });
  }
});

router.post('/:id/mark-read', async (req: AuthRequest, res: Response) => {
  try {
    if (rejectTenantIdInjection(req, res)) return;
    const updated = await markConversationRead({
      conversationId: Number(req.params.id),
      tenantId: req.user!.tenantId,
    });
    if (!updated) return notFound(res);
    res.json({ success: true, data: sanitizeConversationRow(updated) });
  } catch (error) {
    console.error('Error marking conversation read:', error);
    res.status(500).json({ success: false, error: 'Okundu işaretlenemedi' });
  }
});

router.post('/:id/archive', async (req: AuthRequest, res: Response) => {
  try {
    if (rejectTenantIdInjection(req, res)) return;
    const conv = await getOwnedConversation(Number(req.params.id), req.user!.tenantId);
    if (!conv) return notFound(res);

    await query(
      `UPDATE conversations
       SET status = 'ARCHIVED', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND tenant_id = $2`,
      [conv.id, req.user!.tenantId]
    );
    const updated = await getOwnedConversation(conv.id, req.user!.tenantId);
    res.json({ success: true, data: sanitizeConversationRow(updated) });
  } catch (error) {
    console.error('Error archiving conversation:', error);
    res.status(500).json({ success: false, error: 'Arşivlenemedi' });
  }
});

export default router;
