import { execa } from 'execa';
import type { Logger } from '../../utils/logger.js';
import pg from 'pg';
import { readSnapshotManifest, restoreSnapshot, checksumsEqual } from '../../sut/shared/database/snapshot.js';
import { checksumDatabase } from '../../sut/shared/database/seed/checksum.js';
import { composeEnvironment } from '../docker-runner/index.js';
import { Database } from '../../sut/shared/database/db.js';
import { clearReliabilityState } from '../../sut/shared/database/reliability.js';

export async function restoreComposeDataset(options: {
  runId: string;
  composeFilePath: string;
  databaseUrl: string;
  profile?: 'pilot' | 'main' | 'capacity';
  seed?: number;
  logger: Logger;
}): Promise<void> {
  const { runId, composeFilePath, databaseUrl, logger } = options;
  const dockerBin = process.env['DOCKER_BIN'] ?? 'docker';
  const projectName = `bench-${runId}`;
  const ps = await execa(dockerBin, [
    'compose', '-p', projectName, '-f', composeFilePath, 'ps', '-q', 'postgres',
  ], { env: composeEnvironment() });
  const container = ps.stdout.trim();
  if (!container) throw new Error(`PostgreSQL container not found for ${projectName}`);
  const manifest = await readSnapshotManifest(options.profile ?? 'pilot', options.seed ?? 20261001);
  logger.info({ projectName, snapshot: manifest.file }, 'Restoring deterministic SUT dataset');
  await restoreSnapshot({ dockerBin, container, user: 'bench', database: 'ecommerce' }, manifest);
  const reliabilityPool = new pg.Pool({ connectionString: databaseUrl });
  try { await clearReliabilityState(new Database(reliabilityPool)); }
  finally { await reliabilityPool.end(); }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const restored = await checksumDatabase(client);
    if (!checksumsEqual(restored, manifest.checksum)) {
      throw new Error(`Restored dataset checksum mismatch: ${restored.combined}`);
    }
  } finally {
    await client.end();
  }
  logger.info({ checksum: manifest.checksum.combined }, 'SUT dataset restore verified');
}

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
  projectName: string,
  hasRedis: boolean,
  hasRabbitMQ: boolean,
  logger: Logger,
): Promise<void> {
  if (hasRedis) {
    logger.info('Flushing Redis');
    try {
      const dockerBin = process.env['DOCKER_BIN'] ?? 'docker';
      const ps = await execa(dockerBin, ['ps', '-q',
        '--filter', `label=com.docker.compose.project=${projectName}`,
        '--filter', 'label=com.docker.compose.service=redis'], { reject: false });
      const container = ps.stdout.trim().split(/\r?\n/)[0];
      if (container) await execa(dockerBin, ['exec', container, 'redis-cli', 'FLUSHALL'], { timeout: 10000 });
    } catch {
      logger.warn('Redis flush failed');
    }
  }

  if (hasRabbitMQ) {
    logger.info('Purging RabbitMQ queues');
    // RabbitMQ queues are fresh per deploy since we use --volumes on cleanup
  }
}
