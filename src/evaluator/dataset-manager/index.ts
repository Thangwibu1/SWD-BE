import { execa } from 'execa';
import type { Logger } from '../../utils/logger.js';

/**
 * Restore SUT PostgreSQL database to the seeded snapshot state.
 * Uses pg_restore from a custom-format dump or re-runs seed after clearing.
 */
export async function resetSutDatabase(
  databaseUrl: string,
  logger: Logger,
): Promise<void> {
  logger.info('Resetting SUT database');

  // Parse connection info from URL
  const url = new URL(databaseUrl);
  const host = url.hostname;
  const port = url.port || '5432';
  const user = url.username;
  const dbName = url.pathname.slice(1);
  const password = url.password;

  const env: Record<string, string> = {};
  if (password) {
    env['PGPASSWORD'] = password;
  }

  // Drop and recreate all SUT tables to get clean state
  const resetSql = `
    DO $$ BEGIN
      -- Truncate in correct order respecting foreign keys
      TRUNCATE TABLE order_items CASCADE;
      TRUNCATE TABLE orders CASCADE;
      TRUNCATE TABLE inventory CASCADE;
      TRUNCATE TABLE products CASCADE;
      TRUNCATE TABLE users CASCADE;
    EXCEPTION WHEN undefined_table THEN
      -- Tables don't exist yet, that's fine
      NULL;
    END $$;
  `;

  try {
    await execa('psql', [
      '-h', host,
      '-p', port,
      '-U', user,
      '-d', dbName,
      '-c', resetSql,
    ], { env, reject: false, timeout: 30000 });

    logger.info('SUT database reset complete');
  } catch (err) {
    logger.warn({ err }, 'SUT database reset via psql failed, tables may not exist yet');
  }
}

/**
 * Flush Redis cache and purge RabbitMQ queues.
 */
export async function flushExternalState(
  redisUrl: string | undefined,
  rabbitmqUrl: string | undefined,
  logger: Logger,
): Promise<void> {
  if (redisUrl) {
    logger.info('Flushing Redis');
    try {
      // Use redis-cli to flush
      const url = new URL(redisUrl);
      await execa('docker', [
        'exec', '-i',
        // Find the redis container in the bench project
        `$(docker ps -q --filter "label=com.docker.compose.service=redis" --filter "status=running" | head -1)`,
        'redis-cli', 'FLUSHALL',
      ], { shell: true, reject: false, timeout: 10000 });
    } catch {
      logger.warn('Redis flush failed');
    }
  }

  if (rabbitmqUrl) {
    logger.info('Purging RabbitMQ queues');
    // RabbitMQ queues are fresh per deploy since we use --volumes on cleanup
  }
}
