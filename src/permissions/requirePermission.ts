import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth';
import { Permission, hasPermission } from './permissionCatalog';

export function forbidden(res: Response, error = 'Forbidden') {
  return res.status(403).json({ error, code: 'FORBIDDEN' });
}

/**
 * Require one or more permissions (all must match).
 * Uses effective permissions loaded onto req.user by authenticate.
 */
export function requirePermission(...required: Permission[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (req.user.role === 'super_admin') {
      // Platform operators must not auto-bypass tenant isolation via this middleware.
      // They still need a valid tenant-scoped session with tenantRole permissions.
    }
    const perms = req.user.permissions || [];
    if (!hasPermission(perms, required)) {
      forbidden(res, 'Bu işlem için yetkiniz yok');
      return;
    }
    next();
  };
}

export function requireAnyPermission(...required: Permission[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const perms = new Set(req.user.permissions || []);
    if (!required.some((p) => perms.has(p))) {
      forbidden(res, 'Bu işlem için yetkiniz yok');
      return;
    }
    next();
  };
}
