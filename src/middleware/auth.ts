import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/auth';
import { loadUserAuthContext } from '../permissions/permissionService';
import { Permission, TenantRole } from '../permissions/permissionCatalog';

export interface AuthRequest extends Request {
  user?: {
    userId: number;
    email: string;
    tenantId: number;
    /** Platform role: user | admin | super_admin */
    role: string;
    tenantRole: TenantRole | null;
    permissions: Permission[];
    permissionVersion: number;
  };
}

export const authenticate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }

    const token = authHeader.substring(7);
    const payload = verifyToken(token);

    if (!payload) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    const decoded = payload as {
      userId: number;
      email: string;
      tenantId: number;
      role?: string;
      tenantRole?: string;
      permissionVersion?: number;
    };

    const ctx = await loadUserAuthContext(decoded.userId);
    if (!ctx) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    if (!ctx.is_active) {
      res.status(403).json({ error: 'Hesap pasif', code: 'ACCOUNT_DISABLED' });
      return;
    }

    // Tenant isolation: JWT tenant must match DB user tenant (no super_admin bypass)
    if (Number(ctx.tenant_id) !== Number(decoded.tenantId)) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    // Stale permission sessions after role/override changes
    const tokenVersion = Number(decoded.permissionVersion || 0);
    if (tokenVersion !== Number(ctx.permission_version)) {
      res.status(401).json({
        error: 'Oturum yetkileri güncellendi; tekrar giriş yapın',
        code: 'PERMISSIONS_STALE',
      });
      return;
    }

    req.user = {
      userId: ctx.id,
      email: ctx.email,
      tenantId: ctx.tenant_id,
      role: ctx.role || 'user',
      tenantRole: ctx.tenant_role,
      permissions: ctx.permissions,
      permissionVersion: ctx.permission_version,
    };

    next();
  } catch (error) {
    res.status(401).json({ error: 'Authentication failed' });
  }
};

export const isSuperAdmin = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
  if (req.user && req.user.role === 'super_admin') {
    next();
  } else {
    res.status(403).json({ error: 'Forbidden' });
  }
};
