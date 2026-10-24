import type { AppConfig } from '../../../config/env.js';
import { loadSutConfig } from '../../../config/sut-env.js';
import type { Logger } from '../../../utils/logger.js';
import { Database } from '../../shared/database/db.js';
import { createPool } from '../../shared/database/pool.js';
import { ensureReliabilitySchema } from '../../shared/database/reliability.js';
import { claimQueueJob, processQueueJob } from '../../monolith/pg-queue.js';
import { createSutApp, finalizeSutApp } from '../../shared/http/sut-http.js';

export async function bootstrapPgQueueWorker(_config: AppConfig, logger: Logger): Promise<void> {
  const config = loadSutConfig();
  const db = new Database(createPool({ connectionString: config.DATABASE_URL, max: 6 }));
  await ensureReliabilitySchema(db);
  let stopping = false;
  let healthy = true;
  const lanes = Array.from({ length: 4 }, async () => {
    while (!stopping) {
      try {
        const job = await claimQueueJob(db);
        healthy = true;
        if (job) await processQueueJob(db, job);
        else await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        healthy = false;
        logger.warn({ error }, 'PostgreSQL queue operation will retry');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  });
  const app = createSutApp(logger);
  app.get('/ready', (_req, res) =>
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ready' : 'unavailable' }),
  );
  finalizeSutApp(app, logger);
  const server = app.listen(config.SUT_PORT, '0.0.0.0');
  const shutdown = async () => {
    stopping = true;
    server.close();
    await Promise.all(lanes);
    await db.pool.end();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}
