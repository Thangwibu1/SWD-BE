import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';

export const BUSINESS_TABLES = ['inventory', 'order_items', 'orders', 'products', 'users'] as const;

export const SUT_MIGRATIONS_DIR = path.resolve('database/sut-migrations');

/**
 * Applies every SUT migration to an EMPTY database in one transaction.
 *
 * There is intentionally no migration-tracking table: the SUT schema must have
 * exactly five business tables, and every run starts from a restored snapshot,
 * so the database is either empty (migrate) or already a snapshot (skip).
 */
export async function migrateSut(
  client: pg.ClientBase,
  dir = SUT_MIGRATIONS_DIR,
): Promise<string[]> {
  const existing = await listPublicTables(client);
  if (existing.length > 0) {
    throw new Error(
      `SUT database is not empty (found: ${existing.join(', ')}); restore a snapshot instead`,
    );
  }
  const files = (await readdir(dir)).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
  await client.query('BEGIN');
  try {
    for (const file of files) {
      await client.query(await readFile(path.join(dir, file), 'utf8'));
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  return files;
}

export async function listPublicTables(client: pg.ClientBase): Promise<string[]> {
  const res = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  return res.rows.map((r) => r.table_name);
}
