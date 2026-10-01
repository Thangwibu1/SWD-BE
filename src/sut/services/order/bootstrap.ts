import type { AppConfig } from '../../../config/env.js';
import { loadSutConfig } from '../../../config/sut-env.js';
import type { Logger } from '../../../utils/logger.js';
import { createSutApp, finalizeSutApp } from '../../shared/http/sut-http.js';
import { Database } from '../../shared/database/db.js';
import { createPool } from '../../shared/database/pool.js';
import { createOrderModule } from '../../monolith/order-module.js';
import { createBusinessRouter } from '../../shared/router/business-router.js';
import type { SutApis, PaymentApi, PaymentRequest, PaymentResult } from '../../shared/domain/types.js';
import type { InventoryTxOps } from '../../monolith/inventory-module.js';
import { DomainError } from '../../shared/errors/domain-errors.js';
import { connectRedis, RedisCartStore } from '../../monolith/redis-cache.js';
import { MemoryCartStore } from '../../monolith/cart-module.js';
import type { CartStore } from '../../monolith/cart-module.js';
import { createCartModule } from '../../monolith/cart-module.js';
import { currentRequestId } from '../../shared/observability/request-context.js';

const REDIS_CACHE_ARCHITECTURES = new Set(['A06', 'A07', 'A08']);

export async function bootstrapOrderService(_appConfig: AppConfig, logger: Logger): Promise<void> {
  const config = loadSutConfig();
  const archId = config.ARCHITECTURE_ID;
  logger.info({ architectureId: archId }, 'Bootstrapping Order Service');

  const pool = createPool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    applicationName: `order-service-${archId}`,
  });
  const db = new Database(pool);
  
  const INVENTORY_URL = config.INVENTORY_URL || 'http://inventory-service:3000';
  const PAYMENT_URL = config.PAYMENT_URL || 'http://payment-mock:3000';

  // Implement InventoryTxOps via HTTP to inventory-service
  const inventoryTx: InventoryTxOps = {
    async reserveStock(_tx, items) {
      const res = await fetch(`${INVENTORY_URL}/internal/reserve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': currentRequestId() || '' },
        body: JSON.stringify({ items }),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as any;
        throw new DomainError(err.code || 'DEPENDENCY_UNAVAILABLE', err.details);
      }
    },
    async releaseStock(_tx, items) {
      const res = await fetch(`${INVENTORY_URL}/internal/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': currentRequestId() || '' },
        body: JSON.stringify({ items }),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new DomainError('DEPENDENCY_UNAVAILABLE');
    },
    async commitStock(_tx, items) {
      const res = await fetch(`${INVENTORY_URL}/internal/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': currentRequestId() || '' },
        body: JSON.stringify({ items }),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new DomainError('DEPENDENCY_UNAVAILABLE');
    },
  };

  // Implement PaymentApi via HTTP to payment-mock
  const payments: PaymentApi = {
    async charge(request: PaymentRequest): Promise<PaymentResult> {
      const res = await fetch(`${PAYMENT_URL}/payments/mock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': currentRequestId() || '' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as any;
        throw new DomainError(err.code || 'DEPENDENCY_UNAVAILABLE', err.details);
      }
      return res.json() as Promise<PaymentResult>;
    },
  };

  let cartStore: CartStore = new MemoryCartStore();
  if (REDIS_CACHE_ARCHITECTURES.has(archId)) {
    const redis = await connectRedis(config.REDIS_URL, logger);
    cartStore = new RedisCartStore(redis);
    logger.info('Redis connected — cart store active');
  }

  const cart = createCartModule(cartStore);
  const orders = createOrderModule(db, inventoryTx, payments);

  const apis = {
    cart,
    orders,
  } as unknown as SutApis;

  const app = createSutApp(logger);

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: `order-service-${archId}` }));
  app.get('/ready', (_req, res) => res.json({ status: 'ready', checks: [] }));

  app.use(createBusinessRouter(apis, 'order-service'));

  finalizeSutApp(app, logger);

  const server = app.listen(config.SUT_PORT, '0.0.0.0', () => {
    logger.info({ port: config.SUT_PORT, architectureId: archId }, 'Order Service listening');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down Order Service');
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
