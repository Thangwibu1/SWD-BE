import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listPublicTables, migrateSut } from '../../src/sut/shared/database/migrator.js';
import { createPool } from '../../src/sut/shared/database/pool.js';
import { resetFromSnapshot } from '../../src/sut/shared/database/reset.js';
import { checksumDatabase, checksumDataset } from '../../src/sut/shared/database/seed/checksum.js';
import { generateDataset } from '../../src/sut/shared/database/seed/dataset.js';
import type { DatasetProfile } from '../../src/sut/shared/database/seed/dataset.js';
import { loadDataset } from '../../src/sut/shared/database/seed/loader.js';
import { createSnapshot } from '../../src/sut/shared/database/snapshot.js';
import { startTestPostgres } from './helpers/dev-postgres.js';
import type { TestPostgres } from './helpers/dev-postgres.js';
import { Database } from '../../src/sut/shared/database/db.js';
import { ensureReliabilitySchema } from '../../src/sut/shared/database/reliability.js';

const profile: DatasetProfile = {
  name: 'pilot',
  users: 200,
  products: 300,
  orders: 600,
  itemsPerOrder: 3,
};
const SEED = 99;

describe('SUT dataset seed / snapshot / reset (PostgreSQL)', () => {
  let pgc: TestPostgres;
  let pool: pg.Pool;
  let snapshotDir: string;
  const dataset = generateDataset(profile, SEED);
  const expected = checksumDataset(dataset);

  beforeAll(async () => {
    pgc = await startTestPostgres('dataset-reset');
    pool = createPool({ connectionString: pgc.url, max: 2 });
    snapshotDir = await mkdtemp(path.join(os.tmpdir(), 'snap-'));
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await pgc?.stop();
    if (snapshotDir) await rm(snapshotDir, { recursive: true, force: true });
  });

  it('migrates exactly the five business tables and refuses a non-empty db', async () => {
    const client = await pool.connect();
    try {
      await migrateSut(client);
      expect(await listPublicTables(client)).toEqual([
        'inventory',
        'order_items',
        'orders',
        'products',
        'users',
      ]);
      await expect(migrateSut(client)).rejects.toThrow(/not empty/);
    } finally {
      client.release();
    }
  });

  it('enforces schema constraints (negative stock, duplicate idempotency key)', async () => {
    const client = await pool.connect();
    try {
      await loadDataset(client, dataset);
      const product = dataset.products[0]!;
      await expect(
        client.query('UPDATE inventory SET available_quantity = -1 WHERE product_id = $1', [
          product.id,
        ]),
      ).rejects.toThrow(/check constraint/);
      const order = dataset.orders[0]!;
      await expect(
        client.query(
          `INSERT INTO orders (user_id,status,payment_status,total_amount,idempotency_key) VALUES ($1,'PENDING','PENDING',0,$2)`,
          [order.userId, order.idempotencyKey],
        ),
      ).rejects.toThrow(/duplicate key/);
    } finally {
      client.release();
    }
  });

  it('loaded data checksum equals generated checksum', async () => {
    const client = await pool.connect();
    try {
      expect((await checksumDatabase(client)).combined).toBe(expected.combined);
    } finally {
      client.release();
    }
  });

  it('reset restores the snapshot after the data is mutated', async () => {
    const target = {
      dockerBin: 'docker',
      container: pgc.container,
      user: 'bench',
      database: 'ecommerce',
    };
    await createSnapshot(target, { profile: 'pilot', seed: SEED, checksum: expected }, snapshotDir);
    await ensureReliabilitySchema(new Database(pool));
    await pool.query("INSERT INTO reliability.inbox(consumer,event_id) VALUES ('reset-test',gen_random_uuid())");
    await pool.query("INSERT INTO reliability.inventory_operations(order_id,items,state) VALUES (gen_random_uuid(),'[]','RELEASED')");
    await pool.query('UPDATE inventory SET available_quantity = 0');
    await pool.query(`DELETE FROM orders WHERE id = $1`, [dataset.orders[0]!.id]);
    const dirty = await pool.connect();
    try {
      expect((await checksumDatabase(dirty)).combined).not.toBe(expected.combined);
    } finally {
      dirty.release();
    }
    const result = await resetFromSnapshot({
      pool,
      target,
      profile: 'pilot',
      seed: SEED,
      snapshotDir,
    });
    expect(result.combined).toBe(expected.combined);
    expect((await pool.query('SELECT count(*)::int AS count FROM reliability.inbox')).rows[0].count).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS count FROM reliability.inventory_operations')).rows[0].count).toBe(0);
  });
});
