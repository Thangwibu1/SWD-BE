import type { AppConfig } from '../../../config/env.js';
import { loadSutConfig } from '../../../config/sut-env.js';
import type { Logger } from '../../../utils/logger.js';
import { createSutApp, finalizeSutApp } from '../../shared/http/sut-http.js';
import type { Request, Response } from 'express';

export async function bootstrapNotificationMock(_appConfig: AppConfig, logger: Logger): Promise<void> {
  const config = loadSutConfig();
  const archId = config.ARCHITECTURE_ID;
  logger.info({ architectureId: archId }, 'Bootstrapping Notification Mock');

  const app = createSutApp(logger);

  // Liveness and Readiness
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: `notification-mock-${archId}` });
  });
  
  app.get('/ready', (_req, res) => {
    res.json({ status: 'ready', checks: [] });
  });

  // Mock endpoint for async notifications
  app.post('/notifications', (req: Request, res: Response) => {
    logger.info({ body: req.body }, 'Received notification request');
    // Simulate some work, but respond quickly since it's fire-and-forget from the caller's perspective
    res.status(202).json({ status: 'accepted' });
  });

  finalizeSutApp(app, logger);

  const server = app.listen(config.SUT_PORT, '0.0.0.0', () => {
    logger.info({ port: config.SUT_PORT, architectureId: archId }, 'Notification Mock listening');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down Notification Mock');
    server.close(() => process.exit(0));
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
