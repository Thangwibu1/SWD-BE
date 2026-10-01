import type { NextFunction, Request, Response } from 'express';

/**
 * Minimal allowlist CORS (guide section 28: CORS only for the frontend origin).
 * Origins not in the list get no CORS headers, so browsers block them.
 */
export function corsMiddleware(allowedOrigins: readonly string[]) {
  const allowed = new Set(allowedOrigins.map((origin) => origin.trim()).filter(Boolean));
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type,X-Request-Id,Idempotency-Key,Last-Event-ID',
      );
      res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}
