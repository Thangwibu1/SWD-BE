import { loadRegistry } from '../../../evaluator/registry/index.js';
import type { AppConfig } from '../../../config/env.js';
import { loadSutConfig } from '../../../config/sut-env.js';
import type { Logger } from '../../../utils/logger.js';
import { createSutApp, finalizeSutApp } from '../../shared/http/sut-http.js';
import { Database } from '../../shared/database/db.js';
import { createPool } from '../../shared/database/pool.js';
import { createCatalogModule } from '../../monolith/catalog-module.js';
import { createBusinessRouter } from '../../shared/router/business-router.js';
import type { SutApis } from '../../shared/domain/types.js';
import { connectRedis, RedisProductCache } from '../../monolith/redis-cache.js';
import { NullProductCache } from '../../monolith/product-cache.js';
import type { RedisClient } from '../../monolith/redis-cache.js';
import type { ProductCache } from '../../monolith/product-cache.js';


export async function bootstrapCatalogService(_appConfig: AppConfig, logger: Logger): Promise<void> {
  const config = loadSutConfig();
  const archId = config.ARCHITECTURE_ID;
  const profile = loadRegistry().get(archId);
  if (!profile) throw new Error(`Unknown architecture ${archId}`);
  logger.info({ architectureId: archId }, 'Bootstrapping Catalog Service');

  const pool = createPool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    applicationName: `catalog-service-${archId}`,
  });
  const db = new Database(pool);
  
  let redis: RedisClient | undefined;
  let productCache: ProductCache = new NullProductCache();

  if (profile.cache.enabled && profile.cache.targets?.includes('product')) {
    redis = await connectRedis(config.REDIS_URL, logger);
    productCache = new RedisProductCache(redis);
    logger.info('Redis connected — product cache active');
  }

  const catalog = createCatalogModule(db, productCache);

  const apis = {
    catalog,
  } as unknown as SutApis;

  const app = createSutApp(logger);

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: `catalog-service-${archId}` }));
  app.get('/ready', (_req, res) => res.json({ status: 'ready', checks: [] }));

  app.use(createBusinessRouter(apis, 'catalog-service'));

  finalizeSutApp(app, logger);

  const server = app.listen(config.SUT_PORT, '0.0.0.0', () => {
    logger.info({ port: config.SUT_PORT, architectureId: archId }, 'Catalog Service listening');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down Catalog Service');
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
