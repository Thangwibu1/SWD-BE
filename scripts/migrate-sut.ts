/**
 * npm run db:sut:migrate
 * Applies database/sut-migrations to an empty PostgreSQL database.
 * Env: SUT_DATABASE_URL (default: dev compose postgres on 127.0.0.1:25432).
 */
import { migrateSut, listPublicTables } from '../src/sut/shared/database/migrator.js';
import { createPool } from '../src/sut/shared/database/pool.js';
import { DEFAULT_DEV_DATABASE_URL, runScript } from './lib/cli.js';

await runScript(async () => {
  const pool = createPool({
    connectionString: process.env.SUT_DATABASE_URL ?? DEFAULT_DEV_DATABASE_URL,
    max: 1,
  });
  const client = await pool.connect();
  try {
    const applied = await migrateSut(client);
    console.log(JSON.stringify({ applied, tables: await listPublicTables(client) }));
  } finally {
    client.release();
    await pool.end();
  }
});
