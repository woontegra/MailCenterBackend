import { Router, Response } from 'express';
import { query, getClient } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../permissions/requirePermission';
import { badRequest, conflict, notFound } from '../utils/channelPlatform';
import { normalizeContactPointValue } from '../utils/contactNormalize';

const router = Router();
router.use(authenticate);
router.use((req, res, next) => {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    return requirePermission('CONTACT_VIEW')(req as any, res, next);
  }
  return requirePermission('CONTACT_MANAGE')(req as any, res, next);
});

const CHANNELS = new Set(['EMAIL', 'SMS', 'WHATSAPP']);
const PREF_STATUSES = new Set(['UNKNOWN', 'OPTED_IN', 'OPTED_OUT', 'BLOCKED']);
const CONTACT_STATUSES = new Set(['ACTIVE', 'ARCHIVED', 'BLOCKED']);

function tenantIdOf(req: AuthRequest): number {
  return req.user!.tenantId;
}

function userIdOf(req: AuthRequest): number {
  return req.user!.userId;
}

function displayName(c: {
  first_name?: string | null;
  last_name?: string | null;
  company_name?: string | null;
}) {
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
  return name || c.company_name || 'İsimsiz kişi';
}

async function getContactOr404(tenantId: number, contactId: number, res: Response) {
  const result = await query(
    `SELECT * FROM contacts WHERE id = $1 AND tenant_id = $2`,
    [contactId, tenantId]
  );
  if (result.rows.length === 0) {
    notFound(res);
    return null;
  }
  return result.rows[0];
}

async function assertBrandInTenant(tenantId: number, brandId: number): Promise<boolean> {
  const result = await query(
    `SELECT id FROM brands WHERE id = $1 AND tenant_id = $2`,
    [brandId, tenantId]
  );
  return result.rows.length > 0;
}

async function loadContactDetail(tenantId: number, contactId: number) {
  const contact = await query(
    `SELECT * FROM contacts WHERE id = $1 AND tenant_id = $2`,
    [contactId, tenantId]
  );
  if (contact.rows.length === 0) return null;

  const [points, brands, prefs, consent] = await Promise.all([
    query(
      `SELECT * FROM contact_points
       WHERE tenant_id = $1 AND contact_id = $2 AND is_active = true
       ORDER BY channel_type, is_primary DESC, id`,
      [tenantId, contactId]
    ),
    query(
      `SELECT b.id, b.name, b.slug, b.accent_color, cbl.created_at
       FROM contact_brand_links cbl
       JOIN brands b ON b.id = cbl.brand_id AND b.tenant_id = cbl.tenant_id
       WHERE cbl.tenant_id = $1 AND cbl.contact_id = $2
       ORDER BY b.name`,
      [tenantId, contactId]
    ),
    query(
      `SELECT cp.*, b.name AS brand_name
       FROM communication_preferences cp
       LEFT JOIN brands b ON b.id = cp.brand_id AND b.tenant_id = cp.tenant_id
       WHERE cp.tenant_id = $1 AND cp.contact_id = $2
       ORDER BY cp.channel_type, cp.brand_id NULLS FIRST`,
      [tenantId, contactId]
    ),
    query(
      `SELECT ce.*, b.name AS brand_name
       FROM consent_events ce
       LEFT JOIN brands b ON b.id = ce.brand_id AND b.tenant_id = ce.tenant_id
       WHERE ce.tenant_id = $1 AND ce.contact_id = $2
       ORDER BY ce.created_at DESC
       LIMIT 50`,
      [tenantId, contactId]
    ),
  ]);

  const lastOutbound = await query(
    `SELECT MAX(om.sent_at) AS last_contact_at
     FROM outbound_messages om
     WHERE om.tenant_id = $1
       AND (
         EXISTS (
           SELECT 1 FROM contact_points cp
           WHERE cp.tenant_id = $1 AND cp.contact_id = $2 AND cp.is_active = true
             AND (
               LOWER(COALESCE(om.recipient_data->>'to','')) LIKE '%' || cp.normalized_value || '%'
               OR LOWER(COALESCE(om.recipient_data->>'cc','')) LIKE '%' || cp.normalized_value || '%'
             )
         )
       )`,
    [tenantId, contactId]
  );

  const row = contact.rows[0];
  return {
    ...row,
    display_name: displayName(row),
    contact_points: points.rows,
    brands: brands.rows,
    preferences: prefs.rows,
    consent_events: consent.rows,
    last_contact_at: lastOutbound.rows[0]?.last_contact_at || null,
  };
}

async function ensurePrimaryAfterDelete(
  client: any,
  tenantId: number,
  contactId: number,
  channelType: string
) {
  const primary = await client.query(
    `SELECT id FROM contact_points
     WHERE tenant_id = $1 AND contact_id = $2 AND channel_type = $3
       AND is_primary = true AND is_active = true`,
    [tenantId, contactId, channelType]
  );
  if (primary.rows.length > 0) return;

  await client.query(
    `UPDATE contact_points
     SET is_primary = true, updated_at = CURRENT_TIMESTAMP
     WHERE id = (
       SELECT id FROM contact_points
       WHERE tenant_id = $1 AND contact_id = $2 AND channel_type = $3 AND is_active = true
       ORDER BY id ASC
       LIMIT 1
     )`,
    [tenantId, contactId, channelType]
  );
}

async function writeContactEvent(
  tenantId: number,
  contactId: number,
  eventType: string,
  note: string | null,
  userId: number | null,
  client?: any
) {
  const q = client ? client.query.bind(client) : query;
  await q(
    `INSERT INTO contact_events (tenant_id, contact_id, event_type, note, created_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, contactId, eventType, note, userId]
  );
}

async function upsertPreference(params: {
  tenantId: number;
  contactId: number;
  brandId: number | null;
  channelType: string;
  newStatus: string;
  source: string;
  note?: string | null;
  userId: number;
  force?: boolean;
  client?: any;
}) {
  const q = params.client ? params.client.query.bind(params.client) : query;
  const existing = await q(
    params.brandId == null
      ? `SELECT * FROM communication_preferences
         WHERE tenant_id = $1 AND contact_id = $2 AND channel_type = $3 AND brand_id IS NULL`
      : `SELECT * FROM communication_preferences
         WHERE tenant_id = $1 AND contact_id = $2 AND channel_type = $3 AND brand_id = $4`,
    params.brandId == null
      ? [params.tenantId, params.contactId, params.channelType]
      : [params.tenantId, params.contactId, params.channelType, params.brandId]
  );

  const previous = existing.rows[0]?.status || 'UNKNOWN';
  if (previous === params.newStatus) {
    return existing.rows[0] || null;
  }

  // Do not silently flip OPTED_OUT/BLOCKED to OPTED_IN
  if (
    !params.force &&
    (previous === 'OPTED_OUT' || previous === 'BLOCKED') &&
    params.newStatus === 'OPTED_IN' &&
    params.source !== 'user_explicit'
  ) {
    throw Object.assign(new Error('OPTED_OUT/BLOCKED yalnızca açık kullanıcı işlemiyle OPTED_IN yapılabilir'), {
      code: 'CONSENT_GUARD',
    });
  }

  let row;
  if (existing.rows[0]) {
    const updated = await q(
      `UPDATE communication_preferences
       SET status = $1, source = $2, updated_by = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 AND tenant_id = $5
       RETURNING *`,
      [params.newStatus, params.source, params.userId, existing.rows[0].id, params.tenantId]
    );
    row = updated.rows[0];
  } else {
    const inserted = await q(
      `INSERT INTO communication_preferences
         (tenant_id, contact_id, brand_id, channel_type, status, source, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        params.tenantId,
        params.contactId,
        params.brandId,
        params.channelType,
        params.newStatus,
        params.source,
        params.userId,
      ]
    );
    row = inserted.rows[0];
  }

  await q(
    `INSERT INTO consent_events
       (tenant_id, contact_id, brand_id, channel_type, previous_status, new_status, source, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      params.tenantId,
      params.contactId,
      params.brandId,
      params.channelType,
      previous,
      params.newStatus,
      params.source,
      params.note || null,
      params.userId,
    ]
  );

  return row;
}

// GET /api/contacts
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = tenantIdOf(req);
    const search = String(req.query.q || req.query.search || '').trim();
    const status = String(req.query.status || '').trim().toUpperCase();
    const brandId = req.query.brand_id ? Number(req.query.brand_id) : null;
    const channel = String(req.query.channel || req.query.channel_type || '')
      .trim()
      .toUpperCase();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 25));
    const offset = (page - 1) * limit;

    const params: any[] = [tenantId];
    const where: string[] = ['c.tenant_id = $1'];

    if (status && CONTACT_STATUSES.has(status)) {
      params.push(status);
      where.push(`c.status = $${params.length}`);
    } else if (!status) {
      where.push(`c.status <> 'ARCHIVED'`);
    }

    if (brandId && Number.isFinite(brandId)) {
      params.push(brandId);
      where.push(
        `EXISTS (
          SELECT 1 FROM contact_brand_links cbl
          WHERE cbl.tenant_id = c.tenant_id AND cbl.contact_id = c.id AND cbl.brand_id = $${params.length}
        )`
      );
    }

    if (channel && CHANNELS.has(channel)) {
      params.push(channel);
      where.push(
        `EXISTS (
          SELECT 1 FROM contact_points cp
          WHERE cp.tenant_id = c.tenant_id AND cp.contact_id = c.id
            AND cp.channel_type = $${params.length} AND cp.is_active = true
        )`
      );
    }

    if (search) {
      const like = `%${search.replace(/[%_]/g, '\\$&')}%`;
      params.push(like);
      const p = `$${params.length}`;
      where.push(
        `(c.first_name ILIKE ${p} ESCAPE '\\'
          OR c.last_name ILIKE ${p} ESCAPE '\\'
          OR c.company_name ILIKE ${p} ESCAPE '\\'
          OR (COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) ILIKE ${p} ESCAPE '\\'
          OR EXISTS (
            SELECT 1 FROM contact_points cp
            WHERE cp.tenant_id = c.tenant_id AND cp.contact_id = c.id AND cp.is_active = true
              AND (cp.value ILIKE ${p} ESCAPE '\\' OR cp.normalized_value ILIKE ${p} ESCAPE '\\')
          ))`
      );
    }

    const whereSql = where.join(' AND ');

    const countResult = await query(
      `SELECT COUNT(*)::int AS total FROM contacts c WHERE ${whereSql}`,
      params
    );

    params.push(limit, offset);
    const listResult = await query(
      `SELECT c.*,
         (
           SELECT json_agg(json_build_object('id', b.id, 'name', b.name, 'accent_color', b.accent_color) ORDER BY b.name)
           FROM contact_brand_links cbl
           JOIN brands b ON b.id = cbl.brand_id AND b.tenant_id = cbl.tenant_id
           WHERE cbl.tenant_id = c.tenant_id AND cbl.contact_id = c.id
         ) AS brands,
         (
           SELECT json_agg(json_build_object(
             'id', cp.id, 'channel_type', cp.channel_type, 'value', cp.value,
             'normalized_value', cp.normalized_value, 'is_primary', cp.is_primary, 'label', cp.label
           ) ORDER BY cp.channel_type, cp.is_primary DESC)
           FROM contact_points cp
           WHERE cp.tenant_id = c.tenant_id AND cp.contact_id = c.id AND cp.is_active = true
         ) AS contact_points,
         (
           SELECT json_agg(json_build_object('channel_type', pref.channel_type, 'status', pref.status, 'brand_id', pref.brand_id))
           FROM communication_preferences pref
           WHERE pref.tenant_id = c.tenant_id AND pref.contact_id = c.id AND pref.brand_id IS NULL
         ) AS preferences
       FROM contacts c
       WHERE ${whereSql}
       ORDER BY c.updated_at DESC, c.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const items = listResult.rows.map((row: any) => ({
      ...row,
      display_name: displayName(row),
      brands: row.brands || [],
      contact_points: row.contact_points || [],
      preferences: row.preferences || [],
    }));

    res.json({
      data: items,
      pagination: {
        page,
        limit,
        total: countResult.rows[0].total,
        totalPages: Math.ceil(countResult.rows[0].total / limit) || 1,
      },
    });
  } catch (error) {
    console.error('Error listing contacts:', error);
    res.status(500).json({ error: 'Kişiler listelenemedi' });
  }
});

// POST /api/contacts
router.post('/', async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    const tenantId = tenantIdOf(req);
    const { enforceCountQuota, afterCountResourceCreated } = await import('../utils/quotaGuards');
    if (!(await enforceCountQuota(res, tenantId, 'max_contacts'))) return;
    const userId = userIdOf(req);
    const {
      first_name,
      last_name,
      company_name,
      title,
      notes,
      status = 'ACTIVE',
      brand_ids = [],
      contact_points = [],
      country_code,
      whatsapp_opt_in,
      whatsapp_consent,
    } = req.body || {};

    if (status && !CONTACT_STATUSES.has(String(status).toUpperCase())) {
      return badRequest(res, 'Geçersiz kişi durumu');
    }

    const firstName = first_name ? String(first_name).trim() : null;
    const lastName = last_name ? String(last_name).trim() : null;
    const companyName = company_name ? String(company_name).trim() : null;
    const pointsInput = Array.isArray(contact_points) ? contact_points : [];
    const whatsappOptIn = Boolean(whatsapp_opt_in ?? whatsapp_consent);

    if (!firstName && !companyName && pointsInput.length === 0) {
      return badRequest(res, 'En az bir ad, şirket adı veya iletişim noktası gerekli');
    }

    await client.query('BEGIN');

    const contactIns = await client.query(
      `INSERT INTO contacts
         (tenant_id, first_name, last_name, company_name, title, notes, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        tenantId,
        firstName,
        lastName,
        companyName,
        title ? String(title).trim() : null,
        notes ? String(notes).trim() : null,
        String(status || 'ACTIVE').toUpperCase(),
        userId,
      ]
    );
    const contact = contactIns.rows[0];

    const brandIds: number[] = Array.isArray(brand_ids)
      ? brand_ids.map(Number).filter((n) => Number.isFinite(n) && n > 0)
      : [];
    for (const brandId of brandIds) {
      const ok = await assertBrandInTenant(tenantId, brandId);
      if (!ok) {
        await client.query('ROLLBACK');
        return notFound(res, 'Bu marka bulunamadı.');
      }
      await client.query(
        `INSERT INTO contact_brand_links (tenant_id, contact_id, brand_id)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [tenantId, contact.id, brandId]
      );
    }

    const primarySeen = new Set<string>();
    for (const raw of pointsInput) {
      const channelType = String(raw.channel_type || raw.channelType || '').toUpperCase();
      if (!CHANNELS.has(channelType)) {
        await client.query('ROLLBACK');
        return badRequest(res, 'Geçersiz kanal türü');
      }
      const pointValue = raw.value == null ? '' : String(raw.value);
      if (channelType === 'EMAIL' && !pointValue.trim()) {
        // Optional empty email — skip rather than 400
        continue;
      }
      const normalized = await normalizeContactPointValue({
        tenantId,
        channelType: channelType as any,
        value: pointValue,
        countryCode: raw.country_code || country_code || null,
      });
      if (!normalized.ok) {
        await client.query('ROLLBACK');
        return badRequest(res, normalized.ok === false ? normalized.error : 'Geçersiz iletişim');
      }

      const dup = await client.query(
        `SELECT id FROM contact_points
         WHERE tenant_id = $1 AND channel_type = $2 AND normalized_value = $3 AND is_active = true
         LIMIT 1`,
        [tenantId, channelType, normalized.normalized]
      );
      if (dup.rows.length > 0) {
        await client.query('ROLLBACK');
        if (channelType === 'EMAIL') {
          return conflict(res, 'Bu e-posta adresi zaten kayıtlı.');
        }
        return conflict(res, 'Bu telefon numarası zaten kayıtlı.');
      }

      let isPrimary = Boolean(raw.is_primary ?? raw.isPrimary);
      if (primarySeen.has(channelType)) isPrimary = false;
      if (isPrimary) primarySeen.add(channelType);

      try {
        await client.query(
          `INSERT INTO contact_points
             (tenant_id, contact_id, channel_type, value, normalized_value, label, is_primary, is_verified, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, false, true)`,
          [
            tenantId,
            contact.id,
            channelType,
            normalized.value,
            normalized.normalized,
            raw.label ? String(raw.label).trim() : null,
            isPrimary,
          ]
        );
      } catch (err: any) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
          if (channelType === 'EMAIL') {
            return conflict(res, 'Bu e-posta adresi zaten kayıtlı.');
          }
          return conflict(res, 'Bu telefon numarası zaten kayıtlı.');
        }
        throw err;
      }
    }

    // Ensure one primary per channel if any points exist
    for (const ch of CHANNELS) {
      await ensurePrimaryAfterDelete(client, tenantId, contact.id, ch);
    }

    if (whatsappOptIn) {
      await upsertPreference({
        tenantId,
        contactId: contact.id,
        brandId: null,
        channelType: 'WHATSAPP',
        newStatus: 'OPTED_IN',
        source: 'user_explicit',
        note: 'Kişi oluşturma formunda WhatsApp izni verildi',
        userId,
        force: true,
        client,
      });
    }

    await writeContactEvent(tenantId, contact.id, 'CREATED', 'Kişi oluşturuldu', userId, client);

    await client.query('COMMIT');
    await afterCountResourceCreated(tenantId);

    const detail = await loadContactDetail(tenantId, contact.id);
    try {
      const { emitAutomationEvent } = await import('../services/automationEmitter');
      await emitAutomationEvent({
        tenantId,
        triggerType: 'CONTACT_CREATED',
        triggerEventId: `contact:${contact.id}:created`,
        payload: {
          contactId: contact.id,
          companyName: contact.company_name,
          contactStatus: contact.status,
        },
      });
    } catch {
      /* non-fatal */
    }
    res.status(201).json(detail);
  } catch (error: any) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    if (error.code === '23505') {
      return conflict(res, 'Bu telefon numarası zaten kayıtlı.');
    }
    console.error('Error creating contact:', error);
    res.status(500).json({ error: 'Kişi oluşturulamadı' });
  } finally {
    client.release();
  }
});

// GET /api/contacts/:id
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const detail = await loadContactDetail(tenantIdOf(req), Number(req.params.id));
    if (!detail) return notFound(res);
    res.json(detail);
  } catch (error) {
    console.error('Error fetching contact:', error);
    res.status(500).json({ error: 'Kişi getirilemedi' });
  }
});

// PATCH /api/contacts/:id
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = tenantIdOf(req);
    const userId = userIdOf(req);
    const contactId = Number(req.params.id);
    const existing = await getContactOr404(tenantId, contactId, res);
    if (!existing) return;

    const next = {
      first_name:
        req.body.first_name !== undefined
          ? req.body.first_name
            ? String(req.body.first_name).trim()
            : null
          : existing.first_name,
      last_name:
        req.body.last_name !== undefined
          ? req.body.last_name
            ? String(req.body.last_name).trim()
            : null
          : existing.last_name,
      company_name:
        req.body.company_name !== undefined
          ? req.body.company_name
            ? String(req.body.company_name).trim()
            : null
          : existing.company_name,
      title:
        req.body.title !== undefined
          ? req.body.title
            ? String(req.body.title).trim()
            : null
          : existing.title,
      notes:
        req.body.notes !== undefined
          ? req.body.notes
            ? String(req.body.notes).trim()
            : null
          : existing.notes,
      status:
        req.body.status !== undefined
          ? String(req.body.status).toUpperCase()
          : existing.status,
    };

    if (!CONTACT_STATUSES.has(next.status)) {
      return badRequest(res, 'Geçersiz kişi durumu');
    }

    const points = await query(
      `SELECT id FROM contact_points WHERE tenant_id = $1 AND contact_id = $2 AND is_active = true`,
      [tenantId, contactId]
    );
    if (!next.first_name && !next.company_name && points.rows.length === 0) {
      return badRequest(res, 'En az bir ad, şirket adı veya iletişim noktası gerekli');
    }

    await query(
      `UPDATE contacts
       SET first_name = $1, last_name = $2, company_name = $3, title = $4,
           notes = $5, status = $6, updated_at = CURRENT_TIMESTAMP
       WHERE id = $7 AND tenant_id = $8`,
      [
        next.first_name,
        next.last_name,
        next.company_name,
        next.title,
        next.notes,
        next.status,
        contactId,
        tenantId,
      ]
    );

    await writeContactEvent(tenantId, contactId, 'UPDATED', 'Profil güncellendi', userId);

    const detail = await loadContactDetail(tenantId, contactId);
    try {
      const { emitAutomationEvent } = await import('../services/automationEmitter');
      await emitAutomationEvent({
        tenantId,
        triggerType: 'CONTACT_UPDATED',
        triggerEventId: `contact:${contactId}:updated:${Date.now()}`,
        payload: {
          contactId,
          companyName: detail?.company_name,
          contactStatus: detail?.status,
        },
      });
    } catch {
      /* non-fatal */
    }
    res.json(detail);
  } catch (error) {
    console.error('Error updating contact:', error);
    res.status(500).json({ error: 'Kişi güncellenemedi' });
  }
});

// DELETE /api/contacts/:id — soft archive
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = tenantIdOf(req);
    const userId = userIdOf(req);
    const contactId = Number(req.params.id);
    const existing = await getContactOr404(tenantId, contactId, res);
    if (!existing) return;

    await query(
      `UPDATE contacts
       SET status = 'ARCHIVED', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND tenant_id = $2`,
      [contactId, tenantId]
    );
    await writeContactEvent(tenantId, contactId, 'ARCHIVED', 'Kişi arşivlendi', userId);

    res.json({ success: true, status: 'ARCHIVED' });
  } catch (error) {
    console.error('Error archiving contact:', error);
    res.status(500).json({ error: 'Kişi arşivlenemedi' });
  }
});

// POST /api/contacts/:id/contact-points
router.post('/:id/contact-points', async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    const tenantId = tenantIdOf(req);
    const contactId = Number(req.params.id);
    const existing = await getContactOr404(tenantId, contactId, res);
    if (!existing) return;

    const channelType = String(req.body.channel_type || req.body.channelType || '').toUpperCase();
    if (!CHANNELS.has(channelType)) return badRequest(res, 'Geçersiz kanal türü');

    const normalized = await normalizeContactPointValue({
      tenantId,
      channelType: channelType as any,
      value: req.body.value,
      countryCode: req.body.country_code || req.body.countryCode || null,
    });
    if (!normalized.ok) return badRequest(res, normalized.ok === false ? normalized.error : 'Geçersiz iletişim');

    await client.query('BEGIN');

    let isPrimary = Boolean(req.body.is_primary ?? req.body.isPrimary);
    if (isPrimary) {
      await client.query(
        `UPDATE contact_points
         SET is_primary = false, updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $1 AND contact_id = $2 AND channel_type = $3 AND is_active = true`,
        [tenantId, contactId, channelType]
      );
    } else {
      const hasPrimary = await client.query(
        `SELECT id FROM contact_points
         WHERE tenant_id = $1 AND contact_id = $2 AND channel_type = $3
           AND is_primary = true AND is_active = true`,
        [tenantId, contactId, channelType]
      );
      if (hasPrimary.rows.length === 0) isPrimary = true;
    }

    const inserted = await client.query(
      `INSERT INTO contact_points
         (tenant_id, contact_id, channel_type, value, normalized_value, label, is_primary, is_verified, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false, true)
       RETURNING *`,
      [
        tenantId,
        contactId,
        channelType,
        normalized.value,
        normalized.normalized,
        req.body.label ? String(req.body.label).trim() : null,
        isPrimary,
      ]
    );

    await writeContactEvent(
      tenantId,
      contactId,
      'POINT_ADDED',
      `${channelType} iletişim noktası eklendi`,
      userIdOf(req),
      client
    );

    await client.query('COMMIT');
    res.status(201).json(inserted.rows[0]);
  } catch (error: any) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    if (error.code === '23505') {
      return conflict(res, 'Bu telefon numarası zaten kayıtlı.');
    }
    console.error('Error adding contact point:', error);
    res.status(500).json({ error: 'İletişim noktası eklenemedi' });
  } finally {
    client.release();
  }
});

// PATCH /api/contacts/:id/contact-points/:pointId
router.patch('/:id/contact-points/:pointId', async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    const tenantId = tenantIdOf(req);
    const contactId = Number(req.params.id);
    const pointId = Number(req.params.pointId);

    const existing = await query(
      `SELECT * FROM contact_points
       WHERE id = $1 AND contact_id = $2 AND tenant_id = $3 AND is_active = true`,
      [pointId, contactId, tenantId]
    );
    if (existing.rows.length === 0) return notFound(res);
    const point = existing.rows[0];

    let value = point.value;
    let normalizedValue = point.normalized_value;
    if (req.body.value !== undefined) {
      const normalized = await normalizeContactPointValue({
        tenantId,
        channelType: point.channel_type,
        value: req.body.value,
        countryCode: req.body.country_code || req.body.countryCode || null,
      });
      if (!normalized.ok) return badRequest(res, normalized.ok === false ? normalized.error : 'Geçersiz iletişim');
      value = normalized.value;
      normalizedValue = normalized.normalized;
    }

    const label =
      req.body.label !== undefined
        ? req.body.label
          ? String(req.body.label).trim()
          : null
        : point.label;

    await client.query('BEGIN');

    if (req.body.is_primary === true || req.body.isPrimary === true) {
      await client.query(
        `UPDATE contact_points
         SET is_primary = false, updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $1 AND contact_id = $2 AND channel_type = $3 AND is_active = true`,
        [tenantId, contactId, point.channel_type]
      );
    }

    const isPrimary =
      req.body.is_primary !== undefined || req.body.isPrimary !== undefined
        ? Boolean(req.body.is_primary ?? req.body.isPrimary)
        : point.is_primary;

    const updated = await client.query(
      `UPDATE contact_points
       SET value = $1, normalized_value = $2, label = $3, is_primary = $4, updated_at = CURRENT_TIMESTAMP
       WHERE id = $5 AND tenant_id = $6
       RETURNING *`,
      [value, normalizedValue, label, isPrimary, pointId, tenantId]
    );

    if (!isPrimary) {
      await ensurePrimaryAfterDelete(client, tenantId, contactId, point.channel_type);
    }

    await client.query('COMMIT');
    res.json(updated.rows[0]);
  } catch (error: any) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    if (error.code === '23505') {
      return conflict(res, 'Bu iletişim adresi bu tenant içinde zaten kayıtlı');
    }
    console.error('Error updating contact point:', error);
    res.status(500).json({ error: 'İletişim noktası güncellenemedi' });
  } finally {
    client.release();
  }
});

// DELETE /api/contacts/:id/contact-points/:pointId
router.delete('/:id/contact-points/:pointId', async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    const tenantId = tenantIdOf(req);
    const contactId = Number(req.params.id);
    const pointId = Number(req.params.pointId);

    const existing = await query(
      `SELECT * FROM contact_points
       WHERE id = $1 AND contact_id = $2 AND tenant_id = $3 AND is_active = true`,
      [pointId, contactId, tenantId]
    );
    if (existing.rows.length === 0) return notFound(res);
    const point = existing.rows[0];

    await client.query('BEGIN');
    await client.query(
      `UPDATE contact_points
       SET is_active = false, is_primary = false, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND tenant_id = $2`,
      [pointId, tenantId]
    );
    await ensurePrimaryAfterDelete(client, tenantId, contactId, point.channel_type);
    await writeContactEvent(
      tenantId,
      contactId,
      'POINT_REMOVED',
      `${point.channel_type} iletişim noktası kaldırıldı`,
      userIdOf(req),
      client
    );
    await client.query('COMMIT');

    const remainingPrimary = await query(
      `SELECT id FROM contact_points
       WHERE tenant_id = $1 AND contact_id = $2 AND channel_type = $3
         AND is_primary = true AND is_active = true`,
      [tenantId, contactId, point.channel_type]
    );

    res.json({
      success: true,
      has_primary: remainingPrimary.rows.length > 0,
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    console.error('Error deleting contact point:', error);
    res.status(500).json({ error: 'İletişim noktası silinemedi' });
  } finally {
    client.release();
  }
});

// POST /api/contacts/:id/brands
router.post('/:id/brands', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = tenantIdOf(req);
    const contactId = Number(req.params.id);
    const brandId = Number(req.body.brand_id ?? req.body.brandId);
    const existing = await getContactOr404(tenantId, contactId, res);
    if (!existing) return;
    if (!Number.isFinite(brandId)) return badRequest(res, 'brand_id gerekli');
    if (!(await assertBrandInTenant(tenantId, brandId))) return notFound(res);

    await query(
      `INSERT INTO contact_brand_links (tenant_id, contact_id, brand_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [tenantId, contactId, brandId]
    );
    await writeContactEvent(
      tenantId,
      contactId,
      'BRAND_LINKED',
      `Marka bağlantısı eklendi (#${brandId})`,
      userIdOf(req)
    );

    const detail = await loadContactDetail(tenantId, contactId);
    res.status(201).json(detail);
  } catch (error) {
    console.error('Error linking brand:', error);
    res.status(500).json({ error: 'Marka bağlantısı eklenemedi' });
  }
});

// DELETE /api/contacts/:id/brands/:brandId
router.delete('/:id/brands/:brandId', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = tenantIdOf(req);
    const contactId = Number(req.params.id);
    const brandId = Number(req.params.brandId);
    const existing = await getContactOr404(tenantId, contactId, res);
    if (!existing) return;

    const result = await query(
      `DELETE FROM contact_brand_links
       WHERE tenant_id = $1 AND contact_id = $2 AND brand_id = $3
       RETURNING brand_id`,
      [tenantId, contactId, brandId]
    );
    if (result.rows.length === 0) return notFound(res);

    await writeContactEvent(
      tenantId,
      contactId,
      'BRAND_UNLINKED',
      `Marka bağlantısı kaldırıldı (#${brandId})`,
      userIdOf(req)
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error unlinking brand:', error);
    res.status(500).json({ error: 'Marka bağlantısı kaldırılamadı' });
  }
});

// GET /api/contacts/:id/preferences
router.get('/:id/preferences', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = tenantIdOf(req);
    const contactId = Number(req.params.id);
    if (!(await getContactOr404(tenantId, contactId, res))) return;

    const result = await query(
      `SELECT cp.*, b.name AS brand_name
       FROM communication_preferences cp
       LEFT JOIN brands b ON b.id = cp.brand_id AND b.tenant_id = cp.tenant_id
       WHERE cp.tenant_id = $1 AND cp.contact_id = $2
       ORDER BY cp.channel_type, cp.brand_id NULLS FIRST`,
      [tenantId, contactId]
    );
    res.json({ data: result.rows });
  } catch (error) {
    console.error('Error listing preferences:', error);
    res.status(500).json({ error: 'Tercihler getirilemedi' });
  }
});

// PATCH /api/contacts/:id/preferences
router.patch('/:id/preferences', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = tenantIdOf(req);
    const userId = userIdOf(req);
    const contactId = Number(req.params.id);
    if (!(await getContactOr404(tenantId, contactId, res))) return;

    const channelType = String(req.body.channel_type || req.body.channelType || '').toUpperCase();
    const newStatus = String(req.body.status || '').toUpperCase();
    const brandIdRaw = req.body.brand_id ?? req.body.brandId;
    const brandId =
      brandIdRaw === null || brandIdRaw === undefined || brandIdRaw === ''
        ? null
        : Number(brandIdRaw);

    if (!CHANNELS.has(channelType)) return badRequest(res, 'Geçersiz kanal türü');
    if (!PREF_STATUSES.has(newStatus)) return badRequest(res, 'Geçersiz tercih durumu');
    if (brandId !== null) {
      if (!Number.isFinite(brandId)) return badRequest(res, 'Geçersiz brand_id');
      if (!(await assertBrandInTenant(tenantId, brandId))) return notFound(res);
    }

    const source = String(req.body.source || 'user_explicit').slice(0, 100);
    const note = req.body.note ? String(req.body.note).slice(0, 1000) : null;

    try {
      const row = await upsertPreference({
        tenantId,
        contactId,
        brandId,
        channelType,
        newStatus,
        source,
        note,
        userId,
        force: source === 'user_explicit',
      });
      res.json(row);
    } catch (err: any) {
      if (err.code === 'CONSENT_GUARD') {
        return badRequest(res, err.message);
      }
      throw err;
    }
  } catch (error) {
    console.error('Error updating preference:', error);
    res.status(500).json({ error: 'Tercih güncellenemedi' });
  }
});

// GET /api/contacts/:id/timeline
router.get('/:id/timeline', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = tenantIdOf(req);
    const contactId = Number(req.params.id);
    if (!(await getContactOr404(tenantId, contactId, res))) return;

    const points = await query(
      `SELECT channel_type, normalized_value FROM contact_points
       WHERE tenant_id = $1 AND contact_id = $2 AND is_active = true`,
      [tenantId, contactId]
    );

    const emailNorms = points.rows
      .filter((p: any) => p.channel_type === 'EMAIL')
      .map((p: any) => p.normalized_value);

    const [consent, events, outbound] = await Promise.all([
      query(
        `SELECT id, channel_type, previous_status, new_status, source, note, brand_id, created_at, created_by
         FROM consent_events
         WHERE tenant_id = $1 AND contact_id = $2
         ORDER BY created_at DESC
         LIMIT 100`,
        [tenantId, contactId]
      ),
      query(
        `SELECT id, event_type, note, created_at, created_by
         FROM contact_events
         WHERE tenant_id = $1 AND contact_id = $2
         ORDER BY created_at DESC
         LIMIT 100`,
        [tenantId, contactId]
      ),
      emailNorms.length
        ? query(
            `SELECT id, status, subject, channel_type, recipient_data, error_message,
                    created_at, sent_at, failed_at
             FROM outbound_messages
             WHERE tenant_id = $1
               AND (
                 ${emailNorms
                   .map((_, i) => {
                     const p = `$${i + 2}`;
                     return `(LOWER(COALESCE(recipient_data->>'to','')) LIKE '%' || ${p} || '%'
                       OR LOWER(COALESCE(recipient_data->>'cc','')) LIKE '%' || ${p} || '%'
                       OR LOWER(COALESCE(recipient_data->>'bcc','')) LIKE '%' || ${p} || '%')`;
                   })
                   .join(' OR ')}
               )
             ORDER BY COALESCE(sent_at, failed_at, created_at) DESC
             LIMIT 100`,
            [tenantId, ...emailNorms]
          )
        : Promise.resolve({ rows: [] as any[] }),
    ]);

    const timeline: any[] = [];

    for (const row of consent.rows) {
      timeline.push({
        type: 'CONSENT',
        at: row.created_at,
        title: `${row.channel_type}: ${row.previous_status || '—'} → ${row.new_status}`,
        detail: row.note || row.source,
        data: row,
      });
    }

    for (const row of events.rows) {
      timeline.push({
        type: 'CONTACT_EVENT',
        at: row.created_at,
        title: row.event_type,
        detail: row.note,
        data: row,
      });
    }

    for (const row of outbound.rows) {
      const failed = row.status === 'FAILED';
      timeline.push({
        type: failed ? 'OUTBOUND_FAILED' : 'OUTBOUND',
        at: row.sent_at || row.failed_at || row.created_at,
        title: failed ? `Gönderim başarısız: ${row.subject || '(konusuz)'}` : `Gönderildi: ${row.subject || '(konusuz)'}`,
        detail: failed ? row.error_message : row.status,
        data: {
          id: row.id,
          status: row.status,
          channel_type: row.channel_type,
          subject: row.subject,
        },
      });
    }

    timeline.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    res.json({ data: timeline.slice(0, 150) });
  } catch (error) {
    console.error('Error fetching timeline:', error);
    res.status(500).json({ error: 'Zaman çizelgesi getirilemedi' });
  }
});

router.get('/:id/tags', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = tenantIdOf(req);
    const contactId = Number(req.params.id);
    const contact = await getContactOr404(tenantId, contactId, res);
    if (!contact) return;
    const result = await query(
      `SELECT t.id, t.name, t.color, ctl.created_at
       FROM contact_tag_links ctl
       JOIN tags t ON t.id = ctl.tag_id AND t.tenant_id = ctl.tenant_id
       WHERE ctl.tenant_id = $1 AND ctl.contact_id = $2
       ORDER BY t.name`,
      [tenantId, contactId]
    );
    res.json({ data: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Etiketler getirilemedi' });
  }
});

router.post('/:id/tags', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = tenantIdOf(req);
    const contactId = Number(req.params.id);
    const tagId = Number(req.body.tag_id ?? req.body.tagId);
    if (!tagId) return badRequest(res, 'tag_id gerekli');
    const contact = await getContactOr404(tenantId, contactId, res);
    if (!contact) return;
    const tag = await query(`SELECT id FROM tags WHERE id = $1 AND tenant_id = $2`, [tagId, tenantId]);
    if (tag.rows.length === 0) return notFound(res);
    await query(
      `INSERT INTO contact_tag_links (tenant_id, contact_id, tag_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [tenantId, contactId, tagId]
    );
    res.status(201).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Etiket eklenemedi' });
  }
});

router.delete('/:id/tags/:tagId', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = tenantIdOf(req);
    const contactId = Number(req.params.id);
    const tagId = Number(req.params.tagId);
    await query(
      `DELETE FROM contact_tag_links WHERE tenant_id = $1 AND contact_id = $2 AND tag_id = $3`,
      [tenantId, contactId, tagId]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Etiket kaldırılamadı' });
  }
});

export default router;
