import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';
import { query } from '../config/database';

export const checkStorageQuota = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;

    const result = await query(
      'SELECT storage_used_mb, storage_limit_mb FROM tenants WHERE id = $1',
      [tenantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { storage_used_mb, storage_limit_mb } = result.rows[0];

    if (storage_used_mb >= storage_limit_mb) {
      return res.status(429).json({
        error: 'Storage quota exceeded',
        storage_used: storage_used_mb,
        storage_limit: storage_limit_mb,
        upgrade_required: true,
      });
    }

    next();
  } catch (error) {
    console.error('Storage quota check error:', error);
    next();
  }
};

export const updateStorageUsage = async (tenantId: number, sizeMB: number) => {
  try {
    await query(
      'UPDATE tenants SET storage_used_mb = storage_used_mb + $1 WHERE id = $2',
      [sizeMB, tenantId]
    );
  } catch (error) {
    console.error('Update storage usage error:', error);
  }
};

export const calculateMailSize = (mail: any): number => {
  let size = 0;
  
  if (mail.body_preview) {
    size += Buffer.byteLength(mail.body_preview, 'utf8');
  }
  
  if (mail.raw_headers) {
    size += Buffer.byteLength(JSON.stringify(mail.raw_headers), 'utf8');
  }
  
  return size;
};
