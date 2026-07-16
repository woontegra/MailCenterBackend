import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';
import { badRequest, notFound } from '../utils/channelPlatform';
import {
  ensureDomainHealthRow,
  getDomainHealth,
  getOwnedBrand,
} from '../utils/brandDeliverability';
import { normalizeDomainInput } from '../utils/domainValidation';
import { runDeliverabilityDnsCheck } from '../services/deliverabilityDnsService';
import { requirePermission } from '../permissions/requirePermission';

const router = Router({ mergeParams: true });

router.use(authenticate);

function sanitizeHealthRow(row: Record<string, unknown>) {
  // Never include mail account credentials here (none expected)
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    brand_id: row.brand_id,
    brand_name: row.brand_name,
    brand_domain: row.brand_domain,
    brand_accent_color: row.brand_accent_color,
    domain: row.domain,
    spf_status: row.spf_status,
    spf_record: row.spf_record,
    dkim_status: row.dkim_status,
    dkim_selector: row.dkim_selector,
    dkim_record: row.dkim_record,
    dmarc_status: row.dmarc_status,
    dmarc_record: row.dmarc_record,
    mx_status: row.mx_status,
    mx_records: row.mx_records || [],
    last_checked_at: row.last_checked_at,
    overall_status: row.overall_status,
    warnings: row.warnings || [],
    created_at: row.created_at,
    updated_at: row.updated_at,
    disclaimer:
      'Bu sonuçlar yalnızca DNS hazırlığını gösterir; spam klasörüne düşmeme garantisi vermez.',
  };
}

router.get('/:brandId/deliverability', requirePermission('DELIVERABILITY_VIEW'), async (req: AuthRequest, res: Response) => {
  try {
    const { enforceFeature } = await import('../utils/quotaGuards');
    if (!(await enforceFeature(res, req.user!.tenantId, 'deliverability'))) return;
    const tenantId = req.user!.tenantId;
    const brandId = Number(req.params.brandId);
    const brand = await getOwnedBrand(brandId, tenantId);
    if (!brand) return notFound(res);

    const health = await getDomainHealth(tenantId, brandId);
    if (!health) return notFound(res);

    // Prefer brand.domain when health.domain empty
    if (!health.domain && brand.domain) {
      await query(
        `UPDATE domain_health_checks
         SET domain = $1, updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $2 AND brand_id = $3`,
        [String(brand.domain).trim().toLowerCase(), tenantId, brandId]
      );
      const refreshed = await getDomainHealth(tenantId, brandId);
      return res.json(sanitizeHealthRow(refreshed));
    }

    res.json(sanitizeHealthRow(health));
  } catch (error) {
    console.error('Error fetching deliverability:', error);
    res.status(500).json({ error: 'Teslimat sağlığı alınamadı' });
  }
});

router.post('/:brandId/deliverability/check', requirePermission('DELIVERABILITY_MANAGE'), async (req: AuthRequest, res: Response) => {
  const { enforceFeature } = await import('../utils/quotaGuards');
  if (!(await enforceFeature(res, req.user!.tenantId, 'deliverability'))) return;
  try {
    const tenantId = req.user!.tenantId;
    const brandId = Number(req.params.brandId);
    const brand = await getOwnedBrand(brandId, tenantId);
    if (!brand) return notFound(res);

    await ensureDomainHealthRow(tenantId, brandId, brand.domain);

    const existing = await getDomainHealth(tenantId, brandId);
    const domainInput =
      req.body.domain || existing?.domain || brand.domain || '';

    const normalized = normalizeDomainInput(domainInput);
    if (normalized.ok === false) {
      return badRequest(res, normalized.error);
    }

    const selector =
      req.body.dkim_selector ??
      req.body.dkimSelector ??
      existing?.dkim_selector ??
      null;

    const result = await runDeliverabilityDnsCheck({
      domain: normalized.domain,
      dkimSelector: selector,
    });

    // Keep brand.domain in sync when empty
    if (!brand.domain) {
      await query(
        `UPDATE brands SET domain = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND tenant_id = $3`,
        [result.domain, brandId, tenantId]
      );
    }

    const updated = await query(
      `UPDATE domain_health_checks SET
         domain = $1,
         spf_status = $2,
         spf_record = $3,
         dkim_status = $4,
         dkim_selector = $5,
         dkim_record = $6,
         dmarc_status = $7,
         dmarc_record = $8,
         mx_status = $9,
         mx_records = $10::jsonb,
         last_checked_at = CURRENT_TIMESTAMP,
         overall_status = $11,
         warnings = $12::jsonb,
         updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $13 AND brand_id = $14
       RETURNING *`,
      [
        result.domain,
        result.spf_status,
        result.spf_record,
        result.dkim_status,
        result.dkim_selector,
        result.dkim_record,
        result.dmarc_status,
        result.dmarc_record,
        result.mx_status,
        JSON.stringify(result.mx_records),
        result.overall_status,
        JSON.stringify(result.warnings),
        tenantId,
        brandId,
      ]
    );

    const health = await getDomainHealth(tenantId, brandId);
    res.json(sanitizeHealthRow(health || updated.rows[0]));
  } catch (error: any) {
    if (error?.code === 'INVALID_DOMAIN') {
      return badRequest(res, error.message || 'Geçersiz domain');
    }
    console.error('Error checking deliverability:', error?.message || error);
    res.status(500).json({ error: 'DNS kontrolü tamamlanamadı' });
  }
});

router.patch('/:brandId/deliverability/settings', requirePermission('DELIVERABILITY_MANAGE'), async (req: AuthRequest, res: Response) => {
  try {
    const { enforceFeature } = await import('../utils/quotaGuards');
    if (!(await enforceFeature(res, req.user!.tenantId, 'deliverability'))) return;
    const tenantId = req.user!.tenantId;
    const brandId = Number(req.params.brandId);
    const brand = await getOwnedBrand(brandId, tenantId);
    if (!brand) return notFound(res);

    await ensureDomainHealthRow(tenantId, brandId, brand.domain);

    const updates: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (req.body.domain !== undefined) {
      if (req.body.domain === null || req.body.domain === '') {
        updates.push(`domain = $${idx++}`);
        values.push(null);
        await query(
          `UPDATE brands SET domain = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND tenant_id = $2`,
          [brandId, tenantId]
        );
      } else {
        const normalized = normalizeDomainInput(req.body.domain);
        if (normalized.ok === false) return badRequest(res, normalized.error);
        updates.push(`domain = $${idx++}`);
        values.push(normalized.domain);
        await query(
          `UPDATE brands SET domain = $1, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2 AND tenant_id = $3`,
          [normalized.domain, brandId, tenantId]
        );
      }
      // Domain change resets check statuses lightly
      updates.push(`overall_status = 'NOT_CHECKED'`);
      updates.push(`spf_status = 'NOT_CHECKED'`);
      updates.push(`dkim_status = 'NOT_CHECKED'`);
      updates.push(`dmarc_status = 'NOT_CHECKED'`);
      updates.push(`mx_status = 'NOT_CHECKED'`);
      updates.push(`last_checked_at = NULL`);
    }

    if (req.body.dkim_selector !== undefined || req.body.dkimSelector !== undefined) {
      const selectorRaw = req.body.dkim_selector ?? req.body.dkimSelector;
      if (selectorRaw === null || selectorRaw === '') {
        updates.push(`dkim_selector = $${idx++}`);
        values.push(null);
        updates.push(`dkim_status = 'NOT_CHECKED'`);
        updates.push(`dkim_record = NULL`);
      } else {
        const selector = String(selectorRaw).trim().toLowerCase();
        if (!/^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/i.test(selector)) {
          return badRequest(res, 'Geçersiz DKIM selector');
        }
        updates.push(`dkim_selector = $${idx++}`);
        values.push(selector);
        updates.push(`dkim_status = 'NOT_CHECKED'`);
      }
    }

    if (updates.length === 0) {
      return badRequest(res, 'Güncellenecek ayar yok');
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(tenantId, brandId);

    await query(
      `UPDATE domain_health_checks
       SET ${updates.join(', ')}
       WHERE tenant_id = $${idx++} AND brand_id = $${idx}
       RETURNING *`,
      values
    );

    const health = await getDomainHealth(tenantId, brandId);
    res.json(sanitizeHealthRow(health));
  } catch (error) {
    console.error('Error updating deliverability settings:', error);
    res.status(500).json({ error: 'Teslimat ayarları güncellenemedi' });
  }
});

export default router;
