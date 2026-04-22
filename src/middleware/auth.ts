import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/auth';
import { AuthPayload } from '../types';

export interface AuthRequest extends Request {
  user?: {
    userId: number;
    email: string;
    tenantId: number;
    role: string;
  };
}

export const authenticate = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
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
      role: string;
    };

    req.user = {
      userId: decoded.userId,
      email: decoded.email,
      tenantId: decoded.tenantId,
      role: decoded.role || 'user',
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
  if (req.user && req.user.role === 'superadmin') {
    next();
  } else {
    res.status(403).json({ error: 'Forbidden' });
  }
};
