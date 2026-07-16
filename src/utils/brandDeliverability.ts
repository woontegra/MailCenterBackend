import { query } from '../config/database';
import { domainsMatch, extractEmailDomain, normalizeDomainInput } from './domainValidation';

export async function getOwnedBrand(brandId: number, tenantId: number) {
  const result = await query(
    `SELECT id, name, domain, accent_color, is_active
     FROM brands WHERE id = $1 AND tenant_id = $2`,
    [brandId, tenantId]
  );
  return result.rows[0] || null;
}

export async function ensureDomainHealthRow(tenantId: number, brandId: number, domain?: string | null) {
  await query(
    `INSERT INTO domain_health_checks (tenant_id, brand_id, domain)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, brand_id) DO NOTHING`,
    [tenantId, brandId, domain || null]
  );
}

export async function getDomainHealth(tenantId: number, brandId: number) {
  await ensureDomainHealthRow(tenantId, brandId);
  const result = await query(
    `SELECT dhc.*, b.name AS brand_name, b.domain AS brand_domain, b.accent_color AS brand_accent_color
     FROM domain_health_checks dhc
     JOIN brands b ON b.id = dhc.brand_id AND b.tenant_id = dhc.tenant_id
     WHERE dhc.tenant_id = $1 AND dhc.brand_id = $2`,
    [tenantId, brandId]
  );
  return result.rows[0] || null;
}

export async function isBrandDomainDeliverabilityValid(
  tenantId: number,
  brandId: number
): Promise<boolean> {
  const row = await getDomainHealth(tenantId, brandId);
  if (!row) return false;
  return row.overall_status === 'VALID';
}

/**
 * EMAIL sender value must match brand domain when brand.domain is set.
 * Returns { ok, error?, canVerify } — canVerify true only when domain health is VALID.
 */
export async function evaluateSenderDomainPolicy(params: {
  tenantId: number;
  brandId: number;
  senderEmail: string;
}): Promise<{ ok: boolean; error?: string; canVerify: boolean; brandDomain: string | null }> {
  const brand = await getOwnedBrand(params.brandId, params.tenantId);
  if (!brand) {
    return { ok: false, error: 'NOT_FOUND', canVerify: false, brandDomain: null };
  }

  const emailDomain = extractEmailDomain(params.senderEmail);
  if (!emailDomain) {
    return { ok: false, error: 'Geçersiz gönderici e-posta adresi', canVerify: false, brandDomain: null };
  }

  const brandDomainRaw = brand.domain ? String(brand.domain).trim() : '';
  let brandDomain: string | null = null;
  if (brandDomainRaw) {
    const normalized = normalizeDomainInput(brandDomainRaw);
    if (!normalized.ok) {
      return {
        ok: false,
        error: 'Marka alan adı geçersiz; önce marka domainini düzeltin',
        canVerify: false,
        brandDomain: null,
      };
    }
    brandDomain = normalized.domain;
    if (!domainsMatch(emailDomain, brandDomain)) {
      return {
        ok: false,
        error: 'Gönderici e-posta domaini marka alan adıyla uyuşmuyor',
        canVerify: false,
        brandDomain,
      };
    }
  }

  const canVerify = await isBrandDomainDeliverabilityValid(params.tenantId, params.brandId);
  return { ok: true, canVerify, brandDomain };
}
