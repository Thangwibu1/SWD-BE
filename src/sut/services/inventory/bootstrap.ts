import type { AppConfig } from '../../../config/env.js';
import { loadSutConfig } from '../../../config/sut-env.js';
import type { Logger } from '../../../utils/logger.js';
import { createSutApp, finalizeSutApp } from '../../shared/http/sut-http.js';
import { Database } from '../../shared/database/db.js';
import { createPool } from '../../shared/database/pool.js';
import { DomainError } from '../../shared/errors/domain-errors.js';
import { applyInventoryOperation } from './operations.js';
import { ensureReliabilitySchema } from '../../shared/database/reliability.js';
import { createInventoryModule } from '../../monolith/inventory-module.js';
import { RabbitMQClient } from '../../shared/events/rabbitmq.js';

const EVENT_DRIVEN_ARCHITECTURES = new Set(['A09', 'A10', 'A11', 'A12']);

export async function bootstrapInventoryService(_appConfig: AppConfig, logger: Logger): Promise<void> {
  const config = loadSutConfig();
  const archId = config.ARCHITECTURE_ID;
  logger.info({ architectureId: archId }, 'Bootstrapping Inventory Service');

  const pool = createPool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    applicationName: `inventory-service-${archId}`,
  });
  const db = new Database(pool);
  await ensureReliabilitySchema(db);
  
  // Reuse the monolith's inventory module to get the DB operations
  const inventoryModule = createInventoryModule(db);

  const app = createSutApp(logger);

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: `inventory-service-${archId}` }));
  app.get('/ready', (_req, res) => res.json({ status: 'ready', checks: [] }));

  // Mutations are keyed by order ID, with durable inventory operation state.
  for (const action of ['reserve', 'release', 'commit'] as const) {
    app.post(`/internal/${action}`, async (req, res) => {
      await applyInventoryOperation(db, action, req.body.orderId, req.body.items);
      res.json({ status: action });
    });
  }

  finalizeSutApp(app, logger);

  let rabbitmq: RabbitMQClient | undefined;
  if (EVENT_DRIVEN_ARCHITECTURES.has(archId)) {
    const rmqUrl = process.env.RABBITMQ_URL || 'amqp://localhost';
    rabbitmq = new RabbitMQClient(rmqUrl, logger, db);
    await rabbitmq.connect();

    // order.created -> reserveStock
    await rabbitmq.subscribe('inventory.order.created', ['order.created'], async (event) => {
      const { orderId, userId, items, paymentMode, totalAmount } = event.payload;
      try {
        const pending = await db.transaction(async (tx) => {
          const order = await tx.query<{ status: string; inventory_reserved: boolean; inventory_committed: boolean }>(
            'order.lock_inventory_saga',
            'SELECT status, inventory_reserved, inventory_committed FROM orders WHERE id = $1 FOR UPDATE', [orderId],
          );
          const current = order.rows[0];
          if (!current) throw new Error(`Order ${String(orderId)} not found`);
          if (current.status !== 'PENDING') return false;
          if (!current.inventory_reserved && !current.inventory_committed) {
            await inventoryModule.reserveStock(tx, items);
            await tx.query('order.mark_inventory_reserved',
              'UPDATE orders SET inventory_reserved = true, updated_at = now() WHERE id = $1', [orderId]);
          }
          return true;
        });
        if (!pending) return;
        await rabbitmq!.publish('inventory.reserved', {
          eventId: crypto.randomUUID(),
          eventType: 'inventory.reserved',
          occurredAt: new Date().toISOString(),
          aggregateId: orderId,
          correlationId: event.correlationId,
          causationId: event.eventId,
          schemaVersion: 1,
          payload: { orderId, userId, items, paymentMode, amount: totalAmount },
        });
      } catch (err: unknown) {
        if (!(err instanceof DomainError) || !['INSUFFICIENT_STOCK', 'PRODUCT_NOT_FOUND'].includes(err.code)) throw err;
        await rabbitmq!.publish('inventory.rejected', {
          eventId: crypto.randomUUID(),
          eventType: 'inventory.rejected',
          occurredAt: new Date().toISOString(),
          aggregateId: orderId,
          correlationId: event.correlationId,
          causationId: event.eventId,
          schemaVersion: 1,
          payload: { orderId, reason: err instanceof Error ? err.message : String(err) },
        });
      }
    });

    // payment.failed -> releaseStock
    await rabbitmq.subscribe('inventory.payment.failed', ['payment.failed'], async (event) => {
      const { orderId, items } = event.payload;
      if (items) {
        await db.transaction(async (tx) => {
          const claimed = await tx.query('order.claim_inventory_release',
            `UPDATE orders SET inventory_reserved = false, updated_at = now()
             WHERE id = $1 AND inventory_reserved = true AND inventory_committed = false RETURNING id`, [orderId]);
          if ((claimed.rowCount ?? 0) > 0) await inventoryModule.releaseStock(tx, items);
        });
        await rabbitmq!.publish('inventory.released', {
          eventId: crypto.randomUUID(),
          eventType: 'inventory.released',
          occurredAt: new Date().toISOString(),
          aggregateId: orderId,
          correlationId: event.correlationId,
          causationId: event.eventId,
          schemaVersion: 1,
          payload: { orderId, releases: items.map((item: { productId: string; quantity: number }) => ({
            productId: item.productId, quantity: item.quantity,
          })), reason: 'PAYMENT_FAILED' },
        });
      }
    });

    // order.confirmed -> commitStock
    await rabbitmq.subscribe('inventory.order.confirmed', ['order.confirmed'], async (event) => {
      const { orderId, items } = event.payload;
      if (items) {
        await db.transaction(async (tx) => {
          const claimed = await tx.query('order.claim_inventory_commit',
            `UPDATE orders SET inventory_reserved = false, inventory_committed = true, updated_at = now()
             WHERE id = $1 AND status = 'CONFIRMED' AND inventory_reserved = true AND inventory_committed = false RETURNING id`, [orderId]);
          if ((claimed.rowCount ?? 0) > 0) await inventoryModule.commitStock(tx, items);
        });
      }
    });
  }

  const server = app.listen(config.SUT_PORT, '0.0.0.0', () => {
    logger.info({ port: config.SUT_PORT, architectureId: archId }, 'Inventory Service listening');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down Inventory Service');
    if (rabbitmq) await rabbitmq.close().catch(() => {});
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
