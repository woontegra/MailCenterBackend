import { Response } from 'express';

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Safe JSON 500 response: never expose raw error.message / stack / SQL in production.
 * Logs the full error server-side for operators.
 */
export function respondInternalError(
  res: Response,
  error: unknown,
  publicMessage = 'Internal server error'
) {
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown error';
  console.error(publicMessage + ':', detail);

  return res.status(500).json({
    error: isProduction ? publicMessage : detail || publicMessage,
  });
}
