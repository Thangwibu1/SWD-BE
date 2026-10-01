import type { AppConfig } from '../../../config/env.js';
import { loadSutConfig } from '../../../config/sut-env.js';
import type { Logger } from '../../../utils/logger.js';
import { createSutApp, finalizeSutApp } from '../../shared/http/sut-http.js';
import { Database } from '../../shared/database/db.js';
import { createPool } from '../../shared/database/pool.js';
import { createAuthModule } from '../../monolith/auth-module.js';
import { createBusinessRouter } from '../../shared/router/business-router.js';
import type { SutApis } from '../../shared/domain/types.js';

export async function bootstrapUserService(_appConfig: AppConfig, logger: Logger): Promise<void> {
  const config = loadSutConfig();
  const archId = config.ARCHITECTURE_ID;
  logger.info({ architectureId: archId }, 'Bootstrapping User Service');

  const pool = createPool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    applicationName: `user-service-${archId}`,
  });
  const db = new Database(pool);
  
  const auth = createAuthModule(db);

  // Provide only the modules this service implements
  const apis = {
    auth,
  } as unknown as SutApis;

  const app = createSutApp(logger);

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: `user-service-${archId}` }));
  app.get('/ready', (_req, res) => res.json({ status: 'ready', checks: [] }));

  app.use(createBusinessRouter(apis, 'user-service'));

  finalizeSutApp(app, logger);

  const server = app.listen(config.SUT_PORT, '0.0.0.0', () => {
    logger.info({ port: config.SUT_PORT, architectureId: archId }, 'User Service listening');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down User Service');
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
