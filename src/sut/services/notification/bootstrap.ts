import type { AppConfig } from '../../../config/env.js';
import { loadSutConfig } from '../../../config/sut-env.js';
import type { Logger } from '../../../utils/logger.js';
import { createSutApp, finalizeSutApp } from '../../shared/http/sut-http.js';
import type { Request, Response } from 'express';
import { RabbitMQClient } from '../../shared/events/rabbitmq.js';
import { Database } from '../../shared/database/db.js';
import { createPool } from '../../shared/database/pool.js';

const EVENT_DRIVEN_ARCHITECTURES = new Set(['A09', 'A10', 'A11', 'A12']);

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

  let rabbitmq: RabbitMQClient | undefined;
  let pool: ReturnType<typeof createPool> | undefined;
  if (EVENT_DRIVEN_ARCHITECTURES.has(archId)) {
    const rmqUrl = process.env.RABBITMQ_URL || 'amqp://localhost';
    pool = createPool({ connectionString: config.DATABASE_URL, max: config.DB_POOL_MAX, applicationName: `notification-${archId}` });
    rabbitmq = new RabbitMQClient(rmqUrl, logger, new Database(pool));
    await rabbitmq.connect();

    await rabbitmq.subscribe('notification.order.confirmed', ['order.confirmed'], async (event) => {
      logger.info({ orderId: event.payload.orderId }, 'Sent confirmation notification (mock)');
    });

    await rabbitmq.subscribe('notification.order.cancelled', ['order.cancelled'], async (event) => {
      logger.info({ orderId: event.payload.orderId }, 'Sent cancellation notification (mock)');
    });
  }

  const server = app.listen(config.SUT_PORT, '0.0.0.0', () => {
    logger.info({ port: config.SUT_PORT, architectureId: archId }, 'Notification Mock listening');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down Notification Mock');
    if (rabbitmq) await rabbitmq.close().catch(() => {});
    await pool?.end();
    server.close(() => process.exit(0));
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
