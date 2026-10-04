import { Pool } from 'pg';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { createTestLogger } from './logger.js';

const logger = createTestLogger();

/**
 * Get a test database connection pool.
 * Uses TEST_DATABASE_URL environment variable.
 */
export interface TestDatabase {
  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]): Promise<QueryResult<R>>;
  getClient(): Promise<PoolClient>;
  end(): Promise<void>;
}

export async function getTestDb(): Promise<TestDatabase> {
  const connectionString = process.env.TEST_DATABASE_URL ||
    'postgresql://bench:bench@localhost:5432/ecommerce_test';

  const pool = new Pool({
    connectionString,
    max: 5,
  });

  // Test connection
  try {
    const client = await pool.connect();
    client.release();
    logger.info('Test database connected');
  } catch (error) {
    logger.error(error, 'Failed to connect to test database');
    throw error;
  }

  return {
    query: async <R extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []) => {
      const start = Date.now();
      const res = await pool.query<R>(text, [...params]);
      const duration = Date.now() - start;
      logger.debug({ text, duration, rows: res.rowCount }, 'Executed query');
      return res;
    },
    getClient: async () => {
      return pool.connect();
    },
    end: async () => {
      await pool.end();
      logger.info('Test database pool closed');
    },
  };
}

/**
 * Clean test database - truncate all tables.
 */
export async function cleanTestDb(db: TestDatabase): Promise<void> {
  logger.info('Cleaning test database');
  await db.query('TRUNCATE TABLE order_items, orders, inventory, products, users RESTART IDENTITY CASCADE');
}

/**
 * Seed test database with minimal test data.
 */
export async function seedTestDb(db: TestDatabase): Promise<void> {
  logger.info('Seeding test database');

  // Create test users
  await db.query(`
    INSERT INTO users (id, email, password_hash, role)
    VALUES
      ('00000000-0000-0000-0000-000000000001', 'test@example.com', '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8', 'customer'),
      ('00000000-0000-0000-0000-000000000002', 'admin@example.com', '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8', 'admin')
    ON CONFLICT (id) DO NOTHING
  `);

  // Create test products
  await db.query(`
    INSERT INTO products (id, sku, name, category, price, is_active)
    VALUES
      ('00000000-0000-0000-0000-000000000101', 'TEST-001', 'Test Product 1', 'electronics', 9999, true),
      ('00000000-0000-0000-0000-000000000102', 'TEST-002', 'Test Product 2', 'books', 1999, true),
      ('00000000-0000-0000-0000-000000000103', 'TEST-003', 'Test Product 3', 'electronics', 29999, true)
    ON CONFLICT (id) DO NOTHING
  `);

  // Create inventory
  await db.query(`
    INSERT INTO inventory (product_id, available_quantity, reserved_quantity, version)
    VALUES
      ('00000000-0000-0000-0000-000000000101', 100, 0, 0),
      ('00000000-0000-0000-0000-000000000102', 50, 0, 0),
      ('00000000-0000-0000-0000-000000000103', 20, 0, 0)
    ON CONFLICT (product_id) DO UPDATE SET
      available_quantity = EXCLUDED.available_quantity,
      reserved_quantity = 0,
      version = 0
  `);

  logger.info('Test database seeded');
}
