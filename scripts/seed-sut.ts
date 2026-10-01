/**
 * npm run db:sut:seed -- [--profile pilot|main] [--seed 20261001] [--snapshot] [--container name]
 *
 * 1. Generates the deterministic dataset (Zipf product popularity).
 * 2. Migrates + loads it into an EMPTY database (SUT_DATABASE_URL).
 * 3. Verifies the database checksum equals the generated checksum.
 * 4. Writes database/seed/<profile>-<seed>.checksum.json.
 * 5. With --snapshot, pg_dumps via `docker exec <container>` and writes the
 *    snapshot manifest to database/snapshots/.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { migrateSut } from '../src/sut/shared/database/migrator.js';
import { createPool } from '../src/sut/shared/database/pool.js';
import { checksumDatabase, checksumDataset } from '../src/sut/shared/database/seed/checksum.js';
import {
  DATASET_PROFILES,
  DEFAULT_SEED,
  HOT_SKU_COUNT,
  generateDataset,
} from '../src/sut/shared/database/seed/dataset.js';
import type { DatasetProfileName } from '../src/sut/shared/database/seed/dataset.js';
import { loadDataset } from '../src/sut/shared/database/seed/loader.js';
import { createSnapshot } from '../src/sut/shared/database/snapshot.js';
import { DEFAULT_DEV_DATABASE_URL, parseArgs, runScript } from './lib/cli.js';

await runScript(async () => {
  const args = parseArgs();
  const profileName = (args.get('profile') ?? 'pilot') as DatasetProfileName;
  const profile = DATASET_PROFILES[profileName];
  if (!profile) throw new Error(`Unknown profile ${profileName}; use pilot or main`);
  const seed = Number(args.get('seed') ?? DEFAULT_SEED);
  if (!Number.isSafeInteger(seed) || seed < 0)
    throw new Error('--seed must be a non-negative integer');

  const started = Date.now();
  const dataset = generateDataset(profile, seed);
  const expected = checksumDataset(dataset);

  const pool = createPool({
    connectionString: process.env.SUT_DATABASE_URL ?? DEFAULT_DEV_DATABASE_URL,
    max: 1,
    statementTimeoutMs: 600_000,
  });
  const client = await pool.connect();
  try {
    await migrateSut(client);
    await loadDataset(client, dataset);
    const actual = await checksumDatabase(client);
    if (actual.combined !== expected.combined) {
      throw new Error(`Loaded data checksum ${actual.combined} != generated ${expected.combined}`);
    }
  } finally {
    client.release();
    await pool.end();
  }

  const seedDir = path.resolve('database/seed');
  await mkdir(seedDir, { recursive: true });
  const checksumFile = path.join(seedDir, `${profile.name}-${seed}.checksum.json`);
  await writeFile(
    checksumFile,
    `${JSON.stringify(
      {
        profile: profile.name,
        seed,
        counts: Object.fromEntries(Object.entries(expected.tables).map(([t, v]) => [t, v.rows])),
        checksum: expected,
        hotSkus: dataset.popularity.slice(0, HOT_SKU_COUNT),
      },
      null,
      2,
    )}\n`,
  );

  let snapshot: unknown = null;
  if (args.get('snapshot') === 'true') {
    snapshot = await createSnapshot(
      {
        dockerBin: process.env.DOCKER_BIN ?? 'docker',
        container: args.get('container') ?? 'arch-eval-dev-postgres',
        user: 'bench',
        database: 'ecommerce',
      },
      { profile: profile.name, seed, checksum: expected },
    );
  }
  console.log(
    JSON.stringify({
      profile: profile.name,
      seed,
      combined: expected.combined,
      checksumFile,
      snapshot,
      ms: Date.now() - started,
    }),
  );
});
