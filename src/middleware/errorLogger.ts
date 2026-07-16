import { Request, Response, NextFunction } from 'express';
import { AuthRequest } from './auth';
import { query } from '../config/database';

const SENSITIVE_KEY_PATTERN =
  /password|passwd|secret|token|credential|api_key|apikey|authorization|encryption/i;

/** Redact secret-bearing fields before persisting request bodies to error_logs. */
function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 4 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redactSensitive(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? '[REDACTED]'
        : redactSensitive(val, depth + 1);
    }
    return out;
  }
  return value;
}

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
        JSON.stringify(redactSensitive(req.body)),
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
