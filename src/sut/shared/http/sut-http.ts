import express from 'express';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import { pinoHttp } from 'pino-http';
import type { Logger } from '../../../utils/logger.js';
import { requestIdMiddleware } from '../../../utils/request-id.js';
import { DomainError } from '../errors/domain-errors.js';
import { toEnvelope } from '../../../utils/errors.js';
import { runWithContext } from '../observability/request-context.js';

/**
 * Common HTTP shell for every SUT role (monolith, gateway, services), so the
 * request-id, body limit, error envelope and 404 behaviour are identical
 * across all architecture families.
 */
export function createSutApp(logger: Logger): Express {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('query parser', 'simple');
  app.use(requestIdMiddleware);
  app.use((req, _res, next) => runWithContext({ requestId: req.requestId }, next));
  app.use(
    pinoHttp({
      logger,
      customProps: (req) => ({ requestId: (req as Request).requestId }),
      // Probes are polled constantly; keep them out of request logs.
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/ready' },
    }),
  );
  app.use(express.json({ limit: '64kb' }));
  return app;
}

/** Adds the 404 handler and the error-envelope handler. Call after routes. */
export function finalizeSutApp(app: Express, logger: Logger): Express {
  app.use((_req: Request, _res: Response, next: NextFunction) =>
    next(new DomainError('NOT_FOUND')),
  );
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const { status, body } = toEnvelope(error, req.requestId ?? 'unknown');
    // Body-parser failures are client validation errors in the SUT contract.
    if (body.code === 'INVALID_REQUEST_BODY') body.code = 'VALIDATION_FAILED';
    if (status >= 500) logger.error({ err: error, requestId: req.requestId }, 'SUT request failed');
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(status).json(body);
  });
  return app;
}

/** Wraps an async handler so rejections reach the error middleware. */
export const asyncHandler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };
