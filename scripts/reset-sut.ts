/**
 * npm run db:sut:reset -- [--profile pilot] [--seed 20261001] [--container name]
 * Restores the snapshot into the SUT database and verifies the dataset
 * checksum, so a run never reuses state from a previous run.
 */
import { createPool } from '../src/sut/shared/database/pool.js';
import { DEFAULT_SEED } from '../src/sut/shared/database/seed/dataset.js';
import { resetFromSnapshot } from '../src/sut/shared/database/reset.js';
import { DEFAULT_DEV_DATABASE_URL, parseArgs, runScript } from './lib/cli.js';

await runScript(async () => {
  const args = parseArgs();
  const pool = createPool({
    connectionString: process.env.SUT_DATABASE_URL ?? DEFAULT_DEV_DATABASE_URL,
    max: 1,
    statementTimeoutMs: 600_000,
  });
  try {
    const result = await resetFromSnapshot({
      pool,
      target: {
        dockerBin: process.env.DOCKER_BIN ?? 'docker',
        container: args.get('container') ?? 'arch-eval-dev-postgres',
        user: 'bench',
        database: 'ecommerce',
      },
      profile: args.get('profile') ?? 'pilot',
      seed: Number(args.get('seed') ?? DEFAULT_SEED),
    });
    console.log(JSON.stringify(result));
  } finally {
    await pool.end();
  }
});
