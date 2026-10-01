import type { AppConfig } from '../../../config/env.js';
import { loadSutConfig } from '../../../config/sut-env.js';
import type { Logger } from '../../../utils/logger.js';
import { createSutApp, finalizeSutApp } from '../../shared/http/sut-http.js';
import { Database } from '../../shared/database/db.js';
import { createPool } from '../../shared/database/pool.js';
import { DomainError } from '../../shared/errors/domain-errors.js';
import type { Request, Response } from 'express';
import { createInventoryModule } from '../../monolith/inventory-module.js';

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

  const server = app.listen(config.SUT_PORT, '0.0.0.0', () => {
    logger.info({ port: config.SUT_PORT, architectureId: archId }, 'Inventory Service listening');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down Inventory Service');
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
