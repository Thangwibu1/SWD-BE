import type { AppConfig } from '../../../config/env.js';
import { loadSutConfig } from '../../../config/sut-env.js';
import type { Logger } from '../../../utils/logger.js';
import { createSutApp, finalizeSutApp } from '../../shared/http/sut-http.js';
import { createPaymentModule } from '../../monolith/payment-module.js';
import { createBusinessRouter } from '../../shared/router/business-router.js';
import type { SutApis } from '../../shared/domain/types.js';

export async function bootstrapPaymentMock(_appConfig: AppConfig, logger: Logger): Promise<void> {
  const config = loadSutConfig();
  const archId = config.ARCHITECTURE_ID;
  logger.info({ architectureId: archId }, 'Bootstrapping Payment Mock Service');

  const payments = createPaymentModule();

  const apis = {
    payments,
  } as unknown as SutApis;

  const app = createSutApp(logger);

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: `payment-mock-${archId}` }));
  app.get('/ready', (_req, res) => res.json({ status: 'ready', checks: [] }));

  app.use(createBusinessRouter(apis, 'payment-mock'));

  finalizeSutApp(app, logger);

  const server = app.listen(config.SUT_PORT, '0.0.0.0', () => {
    logger.info({ port: config.SUT_PORT, architectureId: archId }, 'Payment Mock Service listening');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down Payment Mock Service');
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
