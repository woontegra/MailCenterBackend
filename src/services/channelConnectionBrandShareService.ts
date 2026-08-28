import { query } from '../config/database';
import { parseWhatsAppSettings } from '../whatsapp/whatsappCredentials';

export type ShareableWhatsAppLine = {
  id: number;
  owner_brand_id: number;
  owner_brand_name: string;
  display_name: string;
  phone_number: string | null;
  label: string;
};

function formatShareLabel(ownerBrandName: string, phone: string | null, displayName: string): string {
  const phonePart = phone || displayName || 'WhatsApp hattı';
  return `${ownerBrandName} — ${phonePart}`;
}

/** Brand may use connection if it owns it or has an explicit share row. */
export async function brandCanUseConnection(
  tenantId: number,
  brandId: number,
  connectionId: number
): Promise<boolean> {
  const res = await query(
    `SELECT cc.id
     FROM channel_connections cc
     WHERE cc.id = $1
       AND cc.tenant_id = $2
       AND cc.channel_type = 'WHATSAPP'
       AND (
         cc.brand_id = $3
         OR EXISTS (
           SELECT 1 FROM channel_connection_brand_shares sh
           WHERE sh.tenant_id = cc.tenant_id
             AND sh.channel_connection_id = cc.id
             AND sh.brand_id = $3
         )
       )`,
    [connectionId, tenantId, brandId]
  );
  return res.rows.length > 0;
}

export async function isConnectionOwnerBrand(
  tenantId: number,
  brandId: number,
  connectionId: number
): Promise<boolean> {
  const res = await query(
    `SELECT id FROM channel_connections
     WHERE id = $1 AND tenant_id = $2 AND brand_id = $3`,
    [connectionId, tenantId, brandId]
  );
  return res.rows.length > 0;
}

/** Active WhatsApp lines in tenant that target brand can adopt (not owned, not already shared). */
export async function listShareableWhatsAppLines(
  tenantId: number,
  targetBrandId: number
): Promise<ShareableWhatsAppLine[]> {
  const res = await query(
    `SELECT cc.id, cc.display_name, cc.settings, cc.brand_id AS owner_brand_id,
            b.name AS owner_brand_name
     FROM channel_connections cc
     JOIN brands b ON b.id = cc.brand_id AND b.tenant_id = cc.tenant_id
     WHERE cc.tenant_id = $1
       AND cc.channel_type = 'WHATSAPP'
       AND UPPER(COALESCE(cc.status, '')) = 'ACTIVE'
       AND cc.brand_id <> $2
       AND cc.encrypted_credentials IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM channel_connection_brand_shares sh
         WHERE sh.tenant_id = cc.tenant_id
           AND sh.channel_connection_id = cc.id
           AND sh.brand_id = $2
       )
     ORDER BY b.name ASC, cc.display_name ASC, cc.id ASC`,
    [tenantId, targetBrandId]
  );

  const lines: ShareableWhatsAppLine[] = [];
  for (const row of res.rows) {
    let phone: string | null = null;
    try {
      phone = parseWhatsAppSettings(row.settings).businessPhoneNumber || null;
    } catch {
      phone = null;
    }
    if (!phone) {
      const settings =
        row.settings && typeof row.settings === 'object' ? (row.settings as Record<string, unknown>) : {};
      phone =
        String(settings.business_phone_number || settings.business_phone || '').trim() || null;
    }
    const displayName = String(row.display_name || '').trim() || 'WhatsApp';
    const ownerBrandName = String(row.owner_brand_name || '').trim() || 'Marka';
    lines.push({
      id: Number(row.id),
      owner_brand_id: Number(row.owner_brand_id),
      owner_brand_name: ownerBrandName,
      display_name: displayName,
      phone_number: phone,
      label: formatShareLabel(ownerBrandName, phone, displayName),
    });
  }
  return lines.filter((line) => Boolean(line.phone_number));
}

export async function shareWhatsAppConnectionWithBrand(params: {
  tenantId: number;
  connectionId: number;
  brandId: number;
  userId: number;
}) {
  const brandOk = await query(`SELECT id FROM brands WHERE id = $1 AND tenant_id = $2`, [
    params.brandId,
    params.tenantId,
  ]);
  if (brandOk.rows.length === 0) {
    throw Object.assign(new Error('Marka bulunamadı'), { status: 404 });
  }

  const conn = await query(
    `SELECT cc.id, cc.brand_id, cc.channel_type, cc.status, cc.display_name, cc.settings,
            cc.encrypted_credentials, b.name AS owner_brand_name
     FROM channel_connections cc
     JOIN brands b ON b.id = cc.brand_id AND b.tenant_id = cc.tenant_id
     WHERE cc.id = $1 AND cc.tenant_id = $2`,
    [params.connectionId, params.tenantId]
  );
  if (conn.rows.length === 0) {
    throw Object.assign(new Error('WhatsApp hattı bulunamadı'), { status: 404 });
  }
  const row = conn.rows[0];
  if (String(row.channel_type).toUpperCase() !== 'WHATSAPP') {
    throw Object.assign(new Error('Yalnızca WhatsApp hatları paylaşılabilir'), { status: 400 });
  }
  if (String(row.status).toUpperCase() !== 'ACTIVE') {
    throw Object.assign(new Error('Yalnızca aktif WhatsApp hatları paylaşılabilir'), { status: 400 });
  }
  if (!row.encrypted_credentials) {
    throw Object.assign(new Error('WhatsApp hattı kullanıma hazır değil'), { status: 400 });
  }
  if (Number(row.brand_id) === Number(params.brandId)) {
    throw Object.assign(new Error('Bu hat zaten bu markaya ait'), { status: 409 });
  }

  const existingShare = await query(
    `SELECT id FROM channel_connection_brand_shares
     WHERE tenant_id = $1 AND channel_connection_id = $2 AND brand_id = $3`,
    [params.tenantId, params.connectionId, params.brandId]
  );
  if (existingShare.rows.length > 0) {
    throw Object.assign(new Error('Bu hat zaten bu markada kullanılıyor'), { status: 409 });
  }

  await query(
    `INSERT INTO channel_connection_brand_shares
       (tenant_id, channel_connection_id, brand_id, created_by)
     VALUES ($1, $2, $3, $4)`,
    [params.tenantId, params.connectionId, params.brandId, params.userId]
  );

  const { ensureWhatsAppSenderForConnection } = await import('../utils/senderIdentityAccess');
  await ensureWhatsAppSenderForConnection(params.connectionId, params.tenantId, params.brandId);

  return {
    connection_id: params.connectionId,
    brand_id: params.brandId,
    owner_brand_name: String(row.owner_brand_name || ''),
    is_shared: true,
  };
}

export async function unshareWhatsAppConnectionFromBrand(params: {
  tenantId: number;
  connectionId: number;
  brandId: number;
}) {
  const conn = await query(
    `SELECT id, brand_id FROM channel_connections
     WHERE id = $1 AND tenant_id = $2 AND channel_type = 'WHATSAPP'`,
    [params.connectionId, params.tenantId]
  );
  if (conn.rows.length === 0) {
    throw Object.assign(new Error('WhatsApp hattı bulunamadı'), { status: 404 });
  }
  if (Number(conn.rows[0].brand_id) === Number(params.brandId)) {
    throw Object.assign(
      new Error('Ana markanın bağlantısı buradan kaldırılamaz; hat sahibi markadan yönetilir'),
      { status: 400 }
    );
  }

  const deleted = await query(
    `DELETE FROM channel_connection_brand_shares
     WHERE tenant_id = $1 AND channel_connection_id = $2 AND brand_id = $3
     RETURNING id`,
    [params.tenantId, params.connectionId, params.brandId]
  );
  if (deleted.rows.length === 0) {
    throw Object.assign(new Error('Bu markada paylaşılan hat bulunamadı'), { status: 404 });
  }

  await query(
    `DELETE FROM sender_identities
     WHERE tenant_id = $1 AND channel_connection_id = $2 AND brand_id = $3 AND channel_type = 'WHATSAPP'`,
    [params.tenantId, params.connectionId, params.brandId]
  );

  return { removed: true };
}

/** Template sync mutates owner-brand rows; shared brands must not trigger sync. */
export async function assertWhatsAppTemplateSyncPermitted(params: {
  tenantId: number;
  connectionId: number;
  requestingBrandId: number;
}) {
  const allowed = await brandCanUseConnection(
    params.tenantId,
    params.requestingBrandId,
    params.connectionId
  );
  if (!allowed) {
    throw Object.assign(new Error('WhatsApp hattına erişim yok'), { status: 403 });
  }
  const owner = await isConnectionOwnerBrand(
    params.tenantId,
    params.requestingBrandId,
    params.connectionId
  );
  if (!owner) {
    throw Object.assign(
      new Error('Şablon senkronizasyonu yalnızca hattın bağlı olduğu markadan yapılabilir'),
      { status: 403 }
    );
  }
}

/** SQL fragment: brand filter including shares (expects $tenantId and brand param index). */
export function brandAccessSql(brandParamIndex: number): string {
  return `(cc.brand_id = $${brandParamIndex} OR EXISTS (
    SELECT 1 FROM channel_connection_brand_shares sh
    WHERE sh.tenant_id = cc.tenant_id
      AND sh.channel_connection_id = cc.id
      AND sh.brand_id = $${brandParamIndex}
  ))`;
}
