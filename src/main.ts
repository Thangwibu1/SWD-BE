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

/**
 * Role table. Roles are registered here as their phase lands; an unknown or
 * not-yet-registered role fails fast instead of silently starting nothing.
 */
const BOOTSTRAPS: Partial<Record<AppRole, Bootstrap>> = {
  'controller-api': bootstrapControllerApi,
  'sut-monolith': bootstrapMonolith,
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
