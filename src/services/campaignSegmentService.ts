import { query } from '../config/database';

export type SegmentFilters = {
  tag_ids?: number[];
  company_name?: string;
  brand_id?: number | null;
  has_email?: boolean;
  created_from?: string;
  created_to?: string;
  last_contact_from?: string;
  last_contact_to?: string;
  included_campaign_id?: number;
  opened_campaign_id?: number;
  clicked_campaign_id?: number;
  bounced_campaign_id?: number;
};

export const UNSUPPORTED_SEGMENT_FILTERS = [
  'opened_campaign_id',
  'clicked_campaign_id',
] as const;

function normalizeFilters(raw: unknown): SegmentFilters {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  return {
    tag_ids: Array.isArray(o.tag_ids) ? o.tag_ids.map(Number).filter(Boolean) : [],
    company_name: o.company_name ? String(o.company_name).trim() : undefined,
    brand_id: o.brand_id ? Number(o.brand_id) : null,
    has_email: o.has_email === undefined ? true : Boolean(o.has_email),
    created_from: o.created_from ? String(o.created_from) : undefined,
    created_to: o.created_to ? String(o.created_to) : undefined,
    last_contact_from: o.last_contact_from ? String(o.last_contact_from) : undefined,
    last_contact_to: o.last_contact_to ? String(o.last_contact_to) : undefined,
    included_campaign_id: o.included_campaign_id ? Number(o.included_campaign_id) : undefined,
    opened_campaign_id: o.opened_campaign_id ? Number(o.opened_campaign_id) : undefined,
    clicked_campaign_id: o.clicked_campaign_id ? Number(o.clicked_campaign_id) : undefined,
    bounced_campaign_id: o.bounced_campaign_id ? Number(o.bounced_campaign_id) : undefined,
  };
}

export function unsupportedFilters(filters: SegmentFilters): string[] {
  const missing: string[] = [];
  if (filters.opened_campaign_id) missing.push('Belirli kampanyayı açanlar');
  if (filters.clicked_campaign_id) missing.push('Belirli kampanyada bağlantıya tıklayanlar');
  return missing;
}

export function buildSegmentContactFilterSql(filters: SegmentFilters, values: unknown[]) {
  let sql = '';

  if (filters.company_name) {
    values.push(filters.company_name);
    sql += ` AND c.company_name ILIKE $${values.length}`;
  }
  if (filters.brand_id) {
    values.push(filters.brand_id);
    sql += ` AND EXISTS (
      SELECT 1 FROM contact_brand_links cbl
      WHERE cbl.tenant_id = c.tenant_id AND cbl.contact_id = c.id AND cbl.brand_id = $${values.length}
    )`;
  }
  if (filters.has_email !== false) {
    sql += ` AND EXISTS (
      SELECT 1 FROM contact_points cp_email
      WHERE cp_email.tenant_id = c.tenant_id
        AND cp_email.contact_id = c.id
        AND cp_email.channel_type = 'EMAIL'
        AND cp_email.is_active = true
        AND TRIM(cp_email.value) <> ''
    )`;
  }
  if (filters.created_from) {
    values.push(filters.created_from);
    sql += ` AND c.created_at >= $${values.length}`;
  }
  if (filters.created_to) {
    values.push(filters.created_to);
    sql += ` AND c.created_at <= $${values.length}`;
  }
  if (filters.tag_ids?.length) {
    values.push(filters.tag_ids);
    sql += ` AND EXISTS (
      SELECT 1 FROM contact_tag_links ctl
      WHERE ctl.tenant_id = c.tenant_id AND ctl.contact_id = c.id AND ctl.tag_id = ANY($${values.length}::int[])
    )`;
  }
  if (filters.last_contact_from) {
    values.push(filters.last_contact_from);
    sql += ` AND EXISTS (
      SELECT 1 FROM contact_events ce
      WHERE ce.tenant_id = c.tenant_id AND ce.contact_id = c.id AND ce.created_at >= $${values.length}
    )`;
  }
  if (filters.last_contact_to) {
    values.push(filters.last_contact_to);
    sql += ` AND EXISTS (
      SELECT 1 FROM contact_events ce
      WHERE ce.tenant_id = c.tenant_id AND ce.contact_id = c.id AND ce.created_at <= $${values.length}
    )`;
  }
  if (filters.included_campaign_id) {
    values.push(filters.included_campaign_id);
    sql += ` AND EXISTS (
      SELECT 1 FROM campaign_recipients cr
      WHERE cr.tenant_id = c.tenant_id AND cr.contact_id = c.id AND cr.campaign_id = $${values.length}
    )`;
  }
  if (filters.bounced_campaign_id) {
    values.push(filters.bounced_campaign_id);
    sql += ` AND EXISTS (
      SELECT 1 FROM campaign_recipients cr
      WHERE cr.tenant_id = c.tenant_id
        AND cr.contact_id = c.id
        AND cr.campaign_id = $${values.length}
        AND cr.status = 'FAILED'
    )`;
  }

  return sql;
}

export async function resolveSegmentContactIds(tenantId: number, filters: SegmentFilters): Promise<number[]> {
  const values: unknown[] = [tenantId];
  const filterSql = buildSegmentContactFilterSql(filters, values);
  const result = await query(
    `SELECT c.id
     FROM contacts c
     WHERE c.tenant_id = $1 AND c.status = 'ACTIVE'
     ${filterSql}
     ORDER BY c.id`,
    values
  );
  return result.rows.map((r) => Number(r.id));
}

export async function previewSegmentCount(tenantId: number, filters: SegmentFilters) {
  const values: unknown[] = [tenantId];
  const filterSql = buildSegmentContactFilterSql(filters, values);
  const result = await query(
    `SELECT COUNT(*)::int AS count
     FROM contacts c
     WHERE c.tenant_id = $1 AND c.status = 'ACTIVE'
     ${filterSql}`,
    values
  );
  return {
    count: Number(result.rows[0]?.count || 0),
    unsupported_filters: unsupportedFilters(filters),
  };
}

export async function listSegments(tenantId: number) {
  const result = await query(
    `SELECT id, name, description, filters, created_at, updated_at
     FROM campaign_segments
     WHERE tenant_id = $1
     ORDER BY updated_at DESC`,
    [tenantId]
  );
  return result.rows;
}

export async function getSegment(tenantId: number, id: number) {
  const result = await query(
    `SELECT id, name, description, filters, created_at, updated_at
     FROM campaign_segments
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id]
  );
  return result.rows[0] || null;
}

export async function createSegment(params: {
  tenantId: number;
  userId: number;
  name: string;
  description?: string | null;
  filters: unknown;
}) {
  const filters = normalizeFilters(params.filters);
  const result = await query(
    `INSERT INTO campaign_segments (tenant_id, name, description, filters, created_by)
     VALUES ($1,$2,$3,$4::jsonb,$5)
     RETURNING id, name, description, filters, created_at, updated_at`,
    [
      params.tenantId,
      params.name.trim(),
      params.description || null,
      JSON.stringify(filters),
      params.userId,
    ]
  );
  return result.rows[0];
}

export async function updateSegment(
  tenantId: number,
  id: number,
  patch: { name?: string; description?: string | null; filters?: unknown }
) {
  const values: unknown[] = [tenantId, id];
  const sets: string[] = [];
  if (patch.name !== undefined) {
    values.push(patch.name.trim());
    sets.push(`name = $${values.length}`);
  }
  if (patch.description !== undefined) {
    values.push(patch.description || null);
    sets.push(`description = $${values.length}`);
  }
  if (patch.filters !== undefined) {
    values.push(JSON.stringify(normalizeFilters(patch.filters)));
    sets.push(`filters = $${values.length}::jsonb`);
  }
  if (sets.length === 0) return getSegment(tenantId, id);
  sets.push('updated_at = CURRENT_TIMESTAMP');
  const result = await query(
    `UPDATE campaign_segments SET ${sets.join(', ')}
     WHERE tenant_id = $1 AND id = $2
     RETURNING id, name, description, filters, created_at, updated_at`,
    values
  );
  return result.rows[0] || null;
}

export async function duplicateSegment(tenantId: number, id: number, userId: number) {
  const src = await getSegment(tenantId, id);
  if (!src) return null;
  return createSegment({
    tenantId,
    userId,
    name: `${src.name} (kopya)`,
    description: src.description,
    filters: src.filters,
  });
}

export async function deleteSegment(tenantId: number, id: number) {
  const result = await query(
    `DELETE FROM campaign_segments WHERE tenant_id = $1 AND id = $2 RETURNING id`,
    [tenantId, id]
  );
  return result.rows[0] || null;
}

export async function loadSegmentFilters(tenantId: number, id: number): Promise<SegmentFilters | null> {
  const segment = await getSegment(tenantId, id);
  if (!segment) return null;
  return normalizeFilters(segment.filters);
}
