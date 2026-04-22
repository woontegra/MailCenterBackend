import { Request, Response, NextFunction } from 'express';
import { AuthRequest } from './auth';
import { query } from '../config/database';

export const logError = async (
  error: Error,
  req: Request | AuthRequest,
  severity: 'info' | 'warning' | 'error' | 'critical' = 'error'
) => {
  try {
    const tenantId = (req as AuthRequest).user?.tenantId || null;
    const userId = (req as AuthRequest).user?.userId || null;

    await query(
      `INSERT INTO error_logs 
       (tenant_id, user_id, error_type, error_message, stack_trace, request_url, 
        request_method, request_body, ip_address, user_agent, severity)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        tenantId,
        userId,
        error.name,
        error.message,
        error.stack,
        req.originalUrl,
        req.method,
        JSON.stringify(req.body),
        req.ip,
        req.get('user-agent'),
        severity
      ]
    );
  } catch (logError) {
    console.error('Failed to log error:', logError);
  }
};

export const errorHandler = async (
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  console.error('Error:', error);

  await logError(error, req, 'error');

  res.status(500).json({
    error: process.env.NODE_ENV === 'production' 
      ? 'Internal server error' 
      : error.message
  });
};
