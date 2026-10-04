import express from 'express';
import type { Express } from 'express';
import { pinoHttp } from 'pino-http';
import type { AppConfig } from '../config/env.js';
import type { Logger } from '../utils/logger.js';
import { requestIdMiddleware } from '../utils/request-id.js';
import { corsMiddleware } from './middleware/cors.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { createV1Router } from './routes/v1.js';
import { getEvaluatorDb } from '../metadata/sqlite.js';

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

  // Health/ready endpoints
  const healthRouter = express.Router();
  healthRouter.get('/health', async (_req, res) => {
    const now = new Date().toISOString();
    const active = getEvaluatorDb().prepare(`SELECT COUNT(*) AS count FROM experiment_runs
      WHERE lease_until >= ? AND state NOT IN ('COMPLETED','FAILED','CANCEL_REQUESTED','CLEANUP_FAILED')`).get(now) as { count: number };
    let prometheusReachable = false;
    try {
      const response = await fetch(`${config.PROMETHEUS_URL}/-/ready`, { signal: AbortSignal.timeout(1500) });
      prometheusReachable = response.ok;
    } catch { /* reported as unreachable without failing liveness */ }
    res.json({
      status: 'ok', role: config.APP_ROLE, version: '0.1.0', environment: config.NODE_ENV,
      uptime: process.uptime(),
      worker: { status: active.count > 0 ? 'busy' : 'idle', activeExperiments: active.count, sandboxLeased: active.count > 0 },
      prometheus: { reachable: prometheusReachable, url: config.PROMETHEUS_URL },
      costCatalog: { version: 'research-v1' },
    });
  });
  healthRouter.get('/ready', async (_req, res) => {
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

  // Mount health + all v1 API routes
  app.use('/api/v1', healthRouter);
  app.use('/api/v1', createV1Router());

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
