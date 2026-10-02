import { loadConfig } from './config/env.js';
import type { AppConfig, AppRole } from './config/env.js';
import { createLogger } from './utils/logger.js';
import type { Logger } from './utils/logger.js';

type Bootstrap = (config: AppConfig, logger: Logger) => Promise<void>;

async function bootstrapControllerApi(config: AppConfig, logger: Logger): Promise<void> {
  const { createApp } = await import('./api/app.js');
  const app = createApp({ config, logger });
  const server = app.listen(config.API_PORT, config.API_HOST, () => {
    logger.info({ host: config.API_HOST, port: config.API_PORT }, 'Evaluator API listening');
  });
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down evaluator API');
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

async function bootstrapMonolith(config: AppConfig, logger: Logger): Promise<void> {
  const { bootstrapMonolith: boot } = await import('./sut/monolith/bootstrap.js');
  await boot(config, logger);
}

async function bootstrapGateway(config: AppConfig, logger: Logger): Promise<void> {
  const { bootstrapGateway: boot } = await import('./sut/gateway/bootstrap.js');
  await boot(config, logger);
}

async function bootstrapNotificationMock(config: AppConfig, logger: Logger): Promise<void> {
  const { bootstrapNotificationMock: boot } = await import('./sut/services/notification/bootstrap.js');
  await boot(config, logger);
}

async function bootstrapUserService(config: AppConfig, logger: Logger): Promise<void> {
  const { bootstrapUserService: boot } = await import('./sut/services/user/bootstrap.js');
  await boot(config, logger);
}

async function bootstrapCatalogService(config: AppConfig, logger: Logger): Promise<void> {
  const { bootstrapCatalogService: boot } = await import('./sut/services/catalog/bootstrap.js');
  await boot(config, logger);
}

async function bootstrapInventoryService(config: AppConfig, logger: Logger): Promise<void> {
  const { bootstrapInventoryService: boot } = await import('./sut/services/inventory/bootstrap.js');
  await boot(config, logger);
}

async function bootstrapOrderService(config: AppConfig, logger: Logger): Promise<void> {
  const { bootstrapOrderService: boot } = await import('./sut/services/order/bootstrap.js');
  await boot(config, logger);
}

async function bootstrapPaymentMock(config: AppConfig, logger: Logger): Promise<void> {
  const { bootstrapPaymentMock: boot } = await import('./sut/services/payment/bootstrap.js');
  await boot(config, logger);
}

async function bootstrapEventWorker(config: AppConfig, logger: Logger): Promise<void> {
  const { bootstrapEventWorker: boot } = await import('./sut/services/event-worker/bootstrap.js');
  await boot(config, logger);
}

/**
 * Role table. Roles are registered here as their phase lands; an unknown or
 * not-yet-registered role fails fast instead of silently starting nothing.
 */
const BOOTSTRAPS: Partial<Record<AppRole, Bootstrap>> = {
  'controller-api': bootstrapControllerApi,
  'sut-monolith': bootstrapMonolith,
  'api-gateway': bootstrapGateway,
  'notification-mock': bootstrapNotificationMock,
  'user-service': bootstrapUserService,
  'catalog-service': bootstrapCatalogService,
  'inventory-service': bootstrapInventoryService,
  'order-service': bootstrapOrderService,
  'payment-mock': bootstrapPaymentMock,
  'event-worker': bootstrapEventWorker,
};

export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.APP_ROLE, config.LOG_LEVEL);
  const bootstrap = BOOTSTRAPS[config.APP_ROLE];
  if (!bootstrap) {
    throw new Error(`APP_ROLE "${config.APP_ROLE}" has no registered bootstrap`);
  }
  await bootstrap(config, logger);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
