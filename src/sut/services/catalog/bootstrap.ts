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

const REDIS_CACHE_ARCHITECTURES = new Set(['A06', 'A07', 'A08']);

export async function bootstrapCatalogService(_appConfig: AppConfig, logger: Logger): Promise<void> {
  const config = loadSutConfig();
  const archId = config.ARCHITECTURE_ID;
  logger.info({ architectureId: archId }, 'Bootstrapping Catalog Service');

  const pool = createPool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    applicationName: `catalog-service-${archId}`,
  });
  const db = new Database(pool);
  
  let redis: RedisClient | undefined;
  let productCache: ProductCache = new NullProductCache();

  if (REDIS_CACHE_ARCHITECTURES.has(archId)) {
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
