import type { AppConfig } from '../../../config/env.js';
import { loadSutConfig } from '../../../config/sut-env.js';
import type { Logger } from '../../../utils/logger.js';
import { Database } from '../../shared/database/db.js';
import { createPool } from '../../shared/database/pool.js';
import { RabbitMQClient } from '../../shared/events/rabbitmq.js';

export async function bootstrapEventWorker(_appConfig: AppConfig, logger: Logger): Promise<void> {
  const config = loadSutConfig();
  const archId = config.ARCHITECTURE_ID;
  logger.info({ architectureId: archId }, 'Bootstrapping Event Worker');

  const pool = createPool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    applicationName: `event-worker-${archId}`,
  });
  const db = new Database(pool);

  const rmqUrl = process.env.RABBITMQ_URL || 'amqp://localhost';
  const rabbitmq = new RabbitMQClient(rmqUrl, logger, db);
  await rabbitmq.connect();

  // Handler: payment.completed
  await rabbitmq.subscribe('order.payment.completed', ['payment.completed'], async (event) => {
    const { orderId, userId, amount, items } = event.payload;
    await db.transaction(async (tx) => {
      await tx.query(
        'order.confirm',
        `UPDATE orders SET status = 'CONFIRMED', payment_status = 'PAID', updated_at = now() WHERE id = $1 AND status = 'PENDING'`,
        [orderId]
      );
    });
    // Publish order.confirmed
    await rabbitmq.publish('order.confirmed', {
      eventId: crypto.randomUUID(),
      eventType: 'order.confirmed',
      occurredAt: new Date().toISOString(),
      aggregateId: orderId,
      correlationId: event.correlationId,
      causationId: event.eventId,
      schemaVersion: 1,
      payload: { orderId, userId, totalAmount: amount, items },
    });
  });

  // Handler: payment.failed
  await rabbitmq.subscribe('order.payment.failed', ['payment.failed'], async (event) => {
    const { orderId } = event.payload;
    await db.transaction(async (tx) => {
      await tx.query(
        'order.fail_payment',
        `UPDATE orders SET status = 'FAILED', payment_status = 'FAILED', updated_at = now() WHERE id = $1 AND status = 'PENDING'`,
        [orderId]
      );
    });
    // Publish order.cancelled
    await rabbitmq.publish('order.cancelled', {
      eventId: crypto.randomUUID(),
      eventType: 'order.cancelled',
      occurredAt: new Date().toISOString(),
      aggregateId: orderId,
      correlationId: event.correlationId,
      causationId: event.eventId,
      schemaVersion: 1,
      payload: { orderId, reason: 'PAYMENT_FAILED' },
    });
  });

  // Handler: inventory.rejected
  await rabbitmq.subscribe('order.inventory.rejected', ['inventory.rejected'], async (event) => {
    const { orderId } = event.payload;
    await db.transaction(async (tx) => {
      await tx.query(
        'order.fail_inventory',
        `UPDATE orders SET status = 'FAILED', updated_at = now() WHERE id = $1 AND status = 'PENDING'`,
        [orderId]
      );
    });
    // Publish order.cancelled
    await rabbitmq.publish('order.cancelled', {
      eventId: crypto.randomUUID(),
      eventType: 'order.cancelled',
      occurredAt: new Date().toISOString(),
      aggregateId: orderId,
      correlationId: event.correlationId,
      causationId: event.eventId,
      schemaVersion: 1,
      payload: { orderId, reason: 'INVENTORY_REJECTED' },
    });
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down Event Worker');
    await rabbitmq.close().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
