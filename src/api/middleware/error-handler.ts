import type { NextFunction, Request, Response } from 'express';
import type { Logger } from '../../utils/logger.js';
import { AppError, toEnvelope } from '../../utils/errors.js';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`));
}

/** Converts any thrown error into the standard error envelope. */
export function errorHandler(logger: Logger) {
  return (error: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const requestId = req.requestId ?? 'unknown';
    const { status, body } = toEnvelope(error, requestId);
    if (status >= 500) {
      logger.error({ err: error, requestId }, 'Unhandled request error');
    }
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(status).json(body);
  };
}
