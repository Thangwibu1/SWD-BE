import type { AppConfig } from '../../../config/env.js';
import { loadSutConfig } from '../../../config/sut-env.js';
import type { Logger } from '../../../utils/logger.js';
import { createSutApp, finalizeSutApp } from '../../shared/http/sut-http.js';
import { Database } from '../../shared/database/db.js';
import { createPool } from '../../shared/database/pool.js';
import { createOrderModule } from '../../monolith/order-module.js';
import { createInventoryModule } from '../../monolith/inventory-module.js';
import { createBusinessRouter } from '../../shared/router/business-router.js';
import type { SutApis, PaymentApi, PaymentRequest, PaymentResult } from '../../shared/domain/types.js';
import { createRestSaga, startSagaRecovery } from './rest-saga.js';
import { ensureReliabilitySchema } from '../../shared/database/reliability.js';
import type { RestSagaDependencies } from './rest-saga.js';
import { DomainError, DOMAIN_ERRORS } from '../../shared/errors/domain-errors.js';
import type { DomainErrorCode } from '../../shared/errors/domain-errors.js';
import { connectRedis, RedisCartStore } from '../../monolith/redis-cache.js';
import { MemoryCartStore } from '../../monolith/cart-module.js';
import type { CartStore } from '../../monolith/cart-module.js';
import { createCartModule } from '../../monolith/cart-module.js';
import { currentRequestId } from '../../shared/observability/request-context.js';
import { RabbitMQClient } from '../../shared/events/rabbitmq.js';
import type { EventEnvelope } from '../../shared/events/rabbitmq.js';
import type { EventPublisher } from '../../monolith/order-module.js';

const REDIS_CACHE_ARCHITECTURES = new Set(['A06', 'A07', 'A08', 'A10', 'A11', 'A12']);
const EVENT_DRIVEN_ARCHITECTURES = new Set(['A09', 'A10', 'A11', 'A12']);

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
  await ensureReliabilitySchema(db);
  
  const INVENTORY_URL = config.INVENTORY_URL || 'http://inventory-service:3000';
  const PAYMENT_URL = config.PAYMENT_URL || 'http://payment-mock:3000';

  const inventory: RestSagaDependencies['inventory'] = async (action, orderId, items) => {
    let res: Response;
    try {
      res = await fetch(`${INVENTORY_URL}/internal/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': currentRequestId() || '' },
        body: JSON.stringify({ orderId, items }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      throw new DomainError('DEPENDENCY_UNAVAILABLE');
    }
    if (!res.ok) {
      const error = await res.json() as { code: string; details?: unknown };
      if (res.status >= 500) throw new DomainError('DEPENDENCY_UNAVAILABLE');
      if (error.code in DOMAIN_ERRORS) throw new DomainError(error.code as DomainErrorCode, error.details);
      throw new DomainError('DEPENDENCY_UNAVAILABLE');
    }
  };

  // Implement PaymentApi via HTTP to payment-mock
  const payments: PaymentApi = {
    async charge(request: PaymentRequest): Promise<PaymentResult> {
      let res: Response;
      try {
        res = await fetch(`${PAYMENT_URL}/payments/mock`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Request-Id': currentRequestId() || '' },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(8000),
        });
      } catch {
        // An ambiguous transport timeout must not be interpreted as a decline.
        throw new DomainError('DEPENDENCY_UNAVAILABLE');
      }
      if (!res.ok) {
        const error = await res.json().catch(() => ({})) as { code?: string; details?: unknown };
        const code = error.code && Object.hasOwn(DOMAIN_ERRORS, error.code)
          ? error.code as DomainErrorCode : 'DEPENDENCY_UNAVAILABLE';
        throw new DomainError(code, error.details);
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

  let rabbitmq: RabbitMQClient | undefined;
  if (EVENT_DRIVEN_ARCHITECTURES.has(archId)) {
    const rmqUrl = process.env.RABBITMQ_URL || 'amqp://localhost';
    rabbitmq = new RabbitMQClient(rmqUrl, logger, db);
    await rabbitmq.connect();
  }

  let publisher: EventPublisher | undefined;
  if (rabbitmq) {
    publisher = {
      publish: async (routingKey, event) => {
        await rabbitmq!.publish(routingKey, {
          eventId: crypto.randomUUID(),
          occurredAt: new Date().toISOString(),
          schemaVersion: 1,
          ...event,
        } as EventEnvelope<unknown>);
      },
    };
  }

  const cart = createCartModule(cartStore);
  const saga = publisher ? undefined : createRestSaga(db, { inventory, payments });
  const stopRecovery = saga ? startSagaRecovery(saga, logger) : undefined;
  const orders = saga ?? createOrderModule(db, createInventoryModule(db), payments, undefined, publisher);

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
    await stopRecovery?.();
    if (rabbitmq) await rabbitmq.close().catch(() => {});
    await pool.end();
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
