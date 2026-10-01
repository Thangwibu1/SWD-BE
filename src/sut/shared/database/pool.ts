import pg from 'pg';

// Return NUMERIC as string so money never goes through binary floating point.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => value);

export interface PoolOptions {
  connectionString: string;
  max?: number;
  statementTimeoutMs?: number;
  applicationName?: string;
}

export function createPool({
  connectionString,
  max = 10,
  statementTimeoutMs = 10_000,
  applicationName = 'sut',
}: PoolOptions): pg.Pool {
  return new pg.Pool({
    connectionString,
    max,
    statement_timeout: statementTimeoutMs,
    application_name: applicationName,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
}

/** Runs fn inside a transaction on a dedicated client; rolls back on any error. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
