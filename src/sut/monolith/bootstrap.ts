import type { AppConfig } from '../../config/env.js';
import { loadSutConfig } from '../../config/sut-env.js';
import type { Logger } from '../../utils/logger.js';
import { Database } from '../shared/database/db.js';
import { createPool } from '../shared/database/pool.js';
import { createSutApp, finalizeSutApp } from '../shared/http/sut-http.js';
import { createBusinessRouter } from '../shared/router/business-router.js';
import type { SutApis } from '../shared/domain/types.js';
import { createAuthModule } from './auth-module.js';
import { createCatalogModule } from './catalog-module.js';
import { createInventoryModule } from './inventory-module.js';
import { createCartModule } from './cart-module.js';
import { createOrderModule } from './order-module.js';
import { createPaymentModule } from './payment-module.js';
import { NullProductCache } from './product-cache.js';
import type { ProductCache } from './product-cache.js';
import { connectRedis, RedisProductCache, RedisCartStore } from './redis-cache.js';
import type { RedisClient } from './redis-cache.js';
import { loadRegistry } from '../../evaluator/registry/index.js';
import { ensureReliabilitySchema } from '../shared/database/reliability.js';
import { createPgQueueOrders, createPgCart } from './pg-queue.js';

/**
 * Bootstraps the modular monolith with capabilities selected from the registry.
 *
 * One Express process with modules communicating via interfaces (guide §10.1).
 * Carts without Redis use shared PostgreSQL, including across replicas.
 * A02: Redis product/cart cache.
 * A03/A04: handled identically except for replica count (Compose-level).
 */
export async function bootstrapMonolith(_appConfig: AppConfig, logger: Logger): Promise<void> {
  const config = loadSutConfig();
  const archId = config.ARCHITECTURE_ID;
  const profile = loadRegistry().get(archId);
  if (!profile) throw new Error(`Unknown architecture ${archId}`);
  const pgQueue = profile.messaging.broker === 'POSTGRES';
  logger.info({ architectureId: archId }, 'Bootstrapping monolith');

  // PostgreSQL
  const pool = createPool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    applicationName: `sut-monolith-${archId}`,
  });
  const db = new Database(pool);
  await ensureReliabilitySchema(db);

  // Redis (optional based on architecture)
  let redis: RedisClient | undefined;
  let productCache: ProductCache = new NullProductCache();
  let redisCart: RedisCartStore | undefined;

  if (profile.cache.enabled) {
    redis = await connectRedis(config.REDIS_URL, logger);
    if (profile.cache.targets?.includes('product')) productCache = new RedisProductCache(redis);
    if (profile.cache.targets?.includes('cart')) redisCart = new RedisCartStore(redis);
    logger.info({ targets: profile.cache.targets }, 'Redis cache connected');
  }

  // Wire modules
  let sendNotification: ((orderId: string) => void) | undefined;
  if (config.NOTIFICATION_URL) {
    sendNotification = (orderId: string) => {
      fetch(`${config.NOTIFICATION_URL}/notifications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType: 'order.completed', orderId }),
      }).catch((err: unknown) => {
        logger.warn({ err, orderId }, 'Failed to send async notification');
      });
    };
  }

  const auth = createAuthModule(db);
  const catalog = createCatalogModule(db, productCache);
  const inventory = createInventoryModule(db);
  const cart = redisCart ? createCartModule(redisCart) : createPgCart(db);
  const payments = createPaymentModule(db);
  const orders = pgQueue ? createPgQueueOrders(db) : createOrderModule(db, inventory, payments, sendNotification);

  const apis: SutApis = { auth, catalog, inventory, cart, orders, payments };

  // Build Express app with real readiness probes BEFORE business router.
  const app = createSutApp(logger);

  // Real /health and /ready — placed before the business router so they
  // take priority over the generic default handlers in business-router.ts.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: `sut-monolith-${archId}` });
  });
  app.get('/ready', async (_req, res) => {
    const checks: Array<{ name: string; ok: boolean }> = [];
    try {
      await db.ping();
      checks.push({ name: 'postgres', ok: true });
    } catch {
      checks.push({ name: 'postgres', ok: false });
    }
    if (redis) {
      try {
        await redis.ping();
        checks.push({ name: 'redis', ok: true });
      } catch {
        checks.push({ name: 'redis', ok: false });
      }
    }
    const allOk = checks.every((c) => c.ok);
    res.status(allOk ? 200 : 503).json({ status: allOk ? 'ready' : 'not-ready', checks });
  });

  app.use(createBusinessRouter(apis, `sut-monolith-${archId}`));
  finalizeSutApp(app, logger);

  const server = app.listen(config.SUT_PORT, '0.0.0.0', () => {
    logger.info({ port: config.SUT_PORT, architectureId: archId }, 'Monolith SUT listening');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down monolith');
    server.close();
    if (redis) await redis.quit().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
