import type { AppConfig } from '../../../config/env.js';
import { loadSutConfig } from '../../../config/sut-env.js';
import type { Logger } from '../../../utils/logger.js';
import { createSutApp, finalizeSutApp } from '../../shared/http/sut-http.js';
import { Database } from '../../shared/database/db.js';
import { createPool } from '../../shared/database/pool.js';
import { DomainError } from '../../shared/errors/domain-errors.js';
import type { Request, Response } from 'express';
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
  
  // Reuse the monolith's inventory module to get the DB operations
  const inventoryModule = createInventoryModule(db);

  const app = createSutApp(logger);

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: `inventory-service-${archId}` }));
  app.get('/ready', (_req, res) => res.json({ status: 'ready', checks: [] }));

  // Internal APIs for REST orchestration
  app.post('/internal/reserve', async (req: Request, res: Response) => {
    try {
      const items = req.body.items as Array<{ productId: string; quantity: number }>;
      await db.transaction(async (tx) => {
        await inventoryModule.reserveStock(tx, items);
      });
      res.json({ status: 'reserved' });
    } catch (error) {
      if (error instanceof DomainError) {
        res.status(400).json({ code: error.code, message: error.message, details: error.details });
      } else {
        res.status(500).json({ code: 'INTERNAL_ERROR', message: String(error) });
      }
    }
  });

  app.post('/internal/release', async (req: Request, res: Response) => {
    try {
      const items = req.body.items as Array<{ productId: string; quantity: number }>;
      await db.transaction(async (tx) => {
        await inventoryModule.releaseStock(tx, items);
      });
      res.json({ status: 'released' });
    } catch (error) {
      res.status(500).json({ code: 'INTERNAL_ERROR', message: String(error) });
    }
  });

  app.post('/internal/commit', async (req: Request, res: Response) => {
    try {
      const items = req.body.items as Array<{ productId: string; quantity: number }>;
      await db.transaction(async (tx) => {
        await inventoryModule.commitStock(tx, items);
      });
      res.json({ status: 'committed' });
    } catch (error) {
      res.status(500).json({ code: 'INTERNAL_ERROR', message: String(error) });
    }
  });

  finalizeSutApp(app, logger);

  let rabbitmq: RabbitMQClient | undefined;
  if (EVENT_DRIVEN_ARCHITECTURES.has(archId)) {
    const rmqUrl = process.env.RABBITMQ_URL || 'amqp://localhost';
    rabbitmq = new RabbitMQClient(rmqUrl, logger);
    await rabbitmq.connect();

    // order.created -> reserveStock
    await rabbitmq.subscribe('inventory.order.created', ['order.created'], async (event) => {
      const { orderId, items, paymentMode, totalAmount } = event.payload;
      try {
        await db.transaction(async (tx) => {
          await inventoryModule.reserveStock(tx, items);
        });
        await rabbitmq!.publish('inventory.reserved', {
          eventId: crypto.randomUUID(),
          eventType: 'inventory.reserved',
          occurredAt: new Date().toISOString(),
          aggregateId: orderId,
          correlationId: event.correlationId,
          causationId: event.eventId,
          schemaVersion: 1,
          payload: { orderId, items, paymentMode, amount: totalAmount },
        });
      } catch (err: unknown) {
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
    await rabbitmq.subscribe('inventory.payment.failed', ['payment.failed', 'order.cancelled'], async (event) => {
      const { orderId, items } = event.payload;
      if (items) {
        await db.transaction(async (tx) => {
          await inventoryModule.releaseStock(tx, items);
        });
        await rabbitmq!.publish('inventory.released', {
          eventId: crypto.randomUUID(),
          eventType: 'inventory.released',
          occurredAt: new Date().toISOString(),
          aggregateId: orderId,
          correlationId: event.correlationId,
          causationId: event.eventId,
          schemaVersion: 1,
          payload: { orderId },
        });
      }
    });

    // order.confirmed -> commitStock
    await rabbitmq.subscribe('inventory.order.confirmed', ['order.confirmed'], async (event) => {
      const { items } = event.payload;
      if (items) {
        await db.transaction(async (tx) => {
          await inventoryModule.commitStock(tx, items);
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
