import express from 'express';
import type { Express } from 'express';
import { pinoHttp } from 'pino-http';
import type { AppConfig } from '../config/env.js';
import type { Logger } from '../utils/logger.js';
import { requestIdMiddleware } from '../utils/request-id.js';
import { corsMiddleware } from './middleware/cors.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';

export interface ReadinessProbe {
  name: string;
  check: () => Promise<boolean> | boolean;
}

export interface AppDependencies {
  config: AppConfig;
  logger: Logger;
  readinessProbes?: ReadinessProbe[];
}

/** Builds the evaluator Express app. Routers are mounted under /api/v1. */
export function createApp({ config, logger, readinessProbes = [] }: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestIdMiddleware);
  app.use(
    pinoHttp({ logger, customProps: (req) => ({ requestId: (req as express.Request).requestId }) }),
  );
  app.use(corsMiddleware(config.CORS_ORIGINS.split(',')));
  app.use(express.json({ limit: '256kb' }));

  const v1 = express.Router();
  v1.get('/health', (_req, res) => {
    res.json({ status: 'ok', role: config.APP_ROLE });
  });
  v1.get('/ready', async (_req, res) => {
    const results = await Promise.all(
      readinessProbes.map(async (probe) => {
        try {
          return { name: probe.name, ok: await probe.check() };
        } catch {
          return { name: probe.name, ok: false };
        }
      }),
    );
    const ready = results.every((result) => result.ok);
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not-ready', checks: results });
  });
  app.use('/api/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
