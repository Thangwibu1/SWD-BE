import type pg from 'pg';
import type { Dataset } from './dataset.js';

// PostgreSQL allows 65535 bind parameters per statement; stay well below.
const MAX_PARAMS = 30_000;

async function insertBatched<T>(
  client: pg.ClientBase,
  table: string,
  columns: readonly string[],
  rows: readonly T[],
  values: (row: T) => unknown[],
): Promise<void> {
  const perBatch = Math.max(1, Math.floor(MAX_PARAMS / columns.length));
  for (let start = 0; start < rows.length; start += perBatch) {
    const batch = rows.slice(start, start + perBatch);
    const params: unknown[] = [];
    const tuples = batch.map((row) => {
      const rowValues = values(row);
      const placeholders = rowValues.map((value) => {
        params.push(value);
        return `$${params.length}`;
      });
      return `(${placeholders.join(',')})`;
    });
    // Table/column names are compile-time constants, never user input.
    await client.query(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')}`,
      params,
    );
  }
}

/** Loads a generated dataset into a freshly migrated SUT database in one transaction. */
export async function loadDataset(client: pg.ClientBase, dataset: Dataset): Promise<void> {
  await client.query('BEGIN');
  try {
    await insertBatched(
      client,
      'users',
      ['id', 'email', 'password_hash', 'role', 'created_at'],
      dataset.users,
      (r) => [r.id, r.email, r.passwordHash, r.role, r.createdAt],
    );
    await insertBatched(
      client,
      'products',
      ['id', 'sku', 'name', 'category', 'price', 'is_active', 'created_at'],
      dataset.products,
      (r) => [r.id, r.sku, r.name, r.category, r.price, r.isActive, r.createdAt],
    );
    await insertBatched(
      client,
      'inventory',
      ['product_id', 'available_quantity', 'reserved_quantity', 'version'],
      dataset.inventory,
      (r) => [r.productId, r.availableQuantity, r.reservedQuantity, r.version],
    );
    await insertBatched(
      client,
      'orders',
      [
        'id',
        'user_id',
        'status',
        'payment_status',
        'total_amount',
        'idempotency_key',
        'created_at',
        'updated_at',
      ],
      dataset.orders,
      (r) => [
        r.id,
        r.userId,
        r.status,
        r.paymentStatus,
        r.totalAmount,
        r.idempotencyKey,
        r.createdAt,
        r.updatedAt,
      ],
    );
    await insertBatched(
      client,
      'order_items',
      ['id', 'order_id', 'product_id', 'quantity', 'unit_price'],
      dataset.orderItems,
      (r) => [r.id, r.orderId, r.productId, r.quantity, r.unitPrice],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  await client.query('ANALYZE');
}
