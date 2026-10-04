import type pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getSutMetrics } from '../observability/metrics.js';

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
  private readonly transactions = new AsyncLocalStorage<SqlExecutor>();
  private savepoint = 0;

  get currentTransaction(): SqlExecutor | undefined {
    return this.transactions.getStore();
  }

  constructor(
    readonly pool: pg.Pool,
    observe?: QueryObserver,
  ) {
    const metrics = getSutMetrics();
    const metricObserver = observe ?? ((operation: string, seconds: number) => metrics.dbQueryDuration.observe({ operation }, seconds));
    const updatePoolMetrics = () => {
      metrics.dbPoolActive.set(Math.max(0, pool.totalCount - pool.idleCount));
      metrics.dbPoolWaiting.set(pool.waitingCount);
    };
    this.executor = new ObservedExecutor(async (text, params) => {
      updatePoolMetrics();
      try { return await pool.query(text, params); } finally { updatePoolMetrics(); }
    }, metricObserver);
    this.observe = metricObserver;
  }

  private readonly observe: QueryObserver;

  query<R extends pg.QueryResultRow = pg.QueryResultRow>(operation: string, text: string, params?: readonly unknown[]) {
    return (this.currentTransaction ?? this.executor).query<R>(operation, text, params);
  }

  /** Runs fn in a READ COMMITTED transaction on one client; rolls back on any error. */
  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const parent = this.currentTransaction;
    if (parent) {
      const name = `nested_${++this.savepoint}`;
      await parent.query('transaction.savepoint', `SAVEPOINT ${name}`);
      try {
        const result = await fn(parent);
        await parent.query('transaction.release', `RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        await parent.query('transaction.rollback', `ROLLBACK TO SAVEPOINT ${name}`);
        await parent.query('transaction.release', `RELEASE SAVEPOINT ${name}`);
        throw error;
      }
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx = new ObservedExecutor((text, params) => client.query(text, params), this.observe);
      const result = await this.transactions.run(tx, () => fn(tx));
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
