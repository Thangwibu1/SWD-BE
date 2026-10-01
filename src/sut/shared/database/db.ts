import type pg from 'pg';

/**
 * Minimal query executor used by every repository. `operation` is a low
 * cardinality label (e.g. "inventory.lock") for db_query_duration_seconds.
 */
export interface SqlExecutor {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    operation: string,
    text: string,
    params?: readonly unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export type QueryObserver = (operation: string, seconds: number) => void;

type RawQuery = (text: string, params: unknown[]) => Promise<pg.QueryResult>;

class ObservedExecutor implements SqlExecutor {
  constructor(
    private readonly run: RawQuery,
    private readonly observe: QueryObserver | undefined,
  ) {}

  async query<R extends pg.QueryResultRow>(operation: string, text: string, params: readonly unknown[] = []) {
    const started = process.hrtime.bigint();
    try {
      return (await this.run(text, [...params])) as pg.QueryResult<R>;
    } finally {
      this.observe?.(operation, Number(process.hrtime.bigint() - started) / 1e9);
    }
  }
}

export class Database implements SqlExecutor {
  private readonly executor: ObservedExecutor;

  constructor(
    readonly pool: pg.Pool,
    private readonly observe?: QueryObserver,
  ) {
    this.executor = new ObservedExecutor((text, params) => pool.query(text, params), observe);
  }

  query<R extends pg.QueryResultRow = pg.QueryResultRow>(operation: string, text: string, params?: readonly unknown[]) {
    return this.executor.query<R>(operation, text, params);
  }

  /** Runs fn in a READ COMMITTED transaction on one client; rolls back on any error. */
  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new ObservedExecutor((text, params) => client.query(text, params), this.observe));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<boolean> {
    await this.pool.query('SELECT 1');
    return true;
  }
}

/** True when error is a PostgreSQL error with the given SQLSTATE (and constraint). */
export function isPgError(error: unknown, code: string, constraint?: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { code?: unknown; constraint?: unknown };
  return e.code === code && (constraint === undefined || e.constraint === constraint);
}
