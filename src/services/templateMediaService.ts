import { query } from '../config/database';
import s3Service from './s3Service';
import {
  sanitizeOriginalFilename,
  validateTemplateMediaFile,
} from '../utils/templateMediaValidation';

export type UploadedTemplateMedia = {
  id: number;
  publicUrl: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
};

export async function uploadTemplateMediaAsset(params: {
  tenantId: number;
  userId: number;
  brandId?: number | null;
  buffer: Buffer;
  originalFilename: string;
  declaredMime?: string;
}): Promise<UploadedTemplateMedia> {
  if (!s3Service.isConfigured()) {
    throw new Error(
      'Dosya depolama servisi yapılandırılmamış. Yöneticinizle iletişime geçin.'
    );
  }

  const validation = validateTemplateMediaFile({
    buffer: params.buffer,
    declaredMime: params.declaredMime,
    sizeBytes: params.buffer.length,
  });

  if (validation.ok === false) {
    throw new Error(validation.error);
  }

  const { mime, extension } = validation;

  if (params.brandId != null) {
    const brandCheck = await query(
      'SELECT id FROM brands WHERE id = $1 AND tenant_id = $2',
      [params.brandId, params.tenantId]
    );
    if (!brandCheck.rows.length) {
      throw new Error('Geçersiz marka');
    }
  }

  const storageKey = await s3Service.uploadTenantPublicFile({
    tenantId: params.tenantId,
    folder: 'template-media',
    extension,
    file: params.buffer,
    contentType: mime,
  });

  const publicUrl = s3Service.getPublicObjectUrl(storageKey);
  const originalFileName = sanitizeOriginalFilename(params.originalFilename);

  const insert = await query(
    `INSERT INTO template_media_assets
       (tenant_id, brand_id, storage_key, public_url, original_filename, mime_type, size_bytes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, public_url, original_filename, mime_type, size_bytes`,
    [
      params.tenantId,
      params.brandId ?? null,
      storageKey,
      publicUrl,
      originalFileName,
      mime,
      params.buffer.length,
      params.userId,
    ]
  );

  const row = insert.rows[0];
  return {
    id: row.id,
    publicUrl: row.public_url,
    originalFileName: row.original_filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
  };
}

export async function getTemplateMediaAssetForTenant(
  tenantId: number,
  mediaAssetId: number
): Promise<{ id: number; public_url: string } | null> {
  const result = await query(
    'SELECT id, public_url FROM template_media_assets WHERE id = $1 AND tenant_id = $2',
    [mediaAssetId, tenantId]
  );
  return result.rows[0] || null;
}
