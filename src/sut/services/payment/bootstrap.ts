import type { AppConfig } from '../../../config/env.js';
import { loadSutConfig } from '../../../config/sut-env.js';
import type { Logger } from '../../../utils/logger.js';
import { createSutApp, finalizeSutApp } from '../../shared/http/sut-http.js';
import { createPaymentModule } from '../../monolith/payment-module.js';
import { createBusinessRouter } from '../../shared/router/business-router.js';
import type { SutApis } from '../../shared/domain/types.js';
import { RabbitMQClient } from '../../shared/events/rabbitmq.js';
import { Database } from '../../shared/database/db.js';
import { createPool } from '../../shared/database/pool.js';
import { ensureReliabilitySchema } from '../../shared/database/reliability.js';
import { DomainError } from '../../shared/errors/domain-errors.js';

const EVENT_DRIVEN_ARCHITECTURES = new Set(['A09', 'A10', 'A11', 'A12']);

export async function bootstrapPaymentMock(_appConfig: AppConfig, logger: Logger): Promise<void> {
  const config = loadSutConfig();
  const archId = config.ARCHITECTURE_ID;
  logger.info({ architectureId: archId }, 'Bootstrapping Payment Mock Service');

  const pool = createPool({ connectionString: config.DATABASE_URL, max: config.DB_POOL_MAX, applicationName: `payment-${archId}` });
  const db = new Database(pool);
  await ensureReliabilitySchema(db);
  const payments = createPaymentModule(db);

  const apis = {
    payments,
  } as unknown as SutApis;

  const app = createSutApp(logger);

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: `payment-mock-${archId}` }));
  app.get('/ready', (_req, res) => res.json({ status: 'ready', checks: [] }));

  app.use(createBusinessRouter(apis, 'payment-mock'));

  finalizeSutApp(app, logger);

  let rabbitmq: RabbitMQClient | undefined;
  if (EVENT_DRIVEN_ARCHITECTURES.has(archId)) {
    const rmqUrl = process.env.RABBITMQ_URL || 'amqp://localhost';
    rabbitmq = new RabbitMQClient(rmqUrl, logger, db);
    await rabbitmq.connect();

    await rabbitmq.subscribe('payment.inventory.reserved', ['inventory.reserved'], async (event) => {
      const { orderId, userId, amount, paymentMode, items } = event.payload;
      try {
        const paymentResult = await payments.charge({ orderId, amount, mode: paymentMode });
        if (paymentResult.status === 'PAID') {
          await rabbitmq!.publish('payment.completed', {
            eventId: crypto.randomUUID(),
            eventType: 'payment.completed',
            occurredAt: new Date().toISOString(),
            aggregateId: orderId,
            correlationId: event.correlationId,
            causationId: event.eventId,
            schemaVersion: 1,
            payload: { orderId, userId, amount, items, transactionId: paymentResult.paymentId },
          });
        } else {
          await rabbitmq!.publish('payment.failed', {
            eventId: crypto.randomUUID(),
            eventType: 'payment.failed',
            occurredAt: new Date().toISOString(),
            aggregateId: orderId,
            correlationId: event.correlationId,
            causationId: event.eventId,
            schemaVersion: 1,
            payload: { orderId, userId, amount, items, reason: 'Payment declined' },
          });
        }
      } catch (err: unknown) {
        if (!(err instanceof DomainError) || err.code !== 'DEPENDENCY_TIMEOUT') throw err;
        await rabbitmq!.publish('payment.failed', {
          eventId: crypto.randomUUID(),
          eventType: 'payment.failed',
          occurredAt: new Date().toISOString(),
          aggregateId: orderId,
          correlationId: event.correlationId,
          causationId: event.eventId,
          schemaVersion: 1,
          payload: { orderId, userId, amount, items, reason: err instanceof Error ? err.message : String(err) },
        });
      }
    });
  }

  const server = app.listen(config.SUT_PORT, '0.0.0.0', () => {
    logger.info({ port: config.SUT_PORT, architectureId: archId }, 'Payment Mock Service listening');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down Payment Mock Service');
    if (rabbitmq) await rabbitmq.close().catch(() => {});
    await pool.end();
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
