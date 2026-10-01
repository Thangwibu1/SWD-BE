import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Dataset } from './dataset.js';

/**
 * Canonical row text per table. The same format is produced by the SQL in
 * DB_ROW_SQL, so a checksum of the generated dataset must equal the checksum
 * of the loaded/restored database. That proves seed and restore fidelity.
 * Timestamps are UTC ISO-8601 with milliseconds (Date#toISOString format).
 */
const ISO_SQL = (col: string) =>
  `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const CHECKSUM_TABLES = ['users', 'products', 'inventory', 'orders', 'order_items'] as const;
export type ChecksumTable = (typeof CHECKSUM_TABLES)[number];

const DB_ROW_SQL: Record<ChecksumTable, { row: string; order: string }> = {
  users: {
    row: `concat_ws('|', id, email, password_hash, role, ${ISO_SQL('created_at')})`,
    order: 'id',
  },
  products: {
    row: `concat_ws('|', id, sku, name, category, price::text, is_active::text, ${ISO_SQL('created_at')})`,
    order: 'id',
  },
  inventory: {
    row: `concat_ws('|', product_id, available_quantity, reserved_quantity, version)`,
    order: 'product_id',
  },
  orders: {
    row: `concat_ws('|', id, user_id, status, payment_status, total_amount::text, idempotency_key, ${ISO_SQL('created_at')}, ${ISO_SQL('updated_at')})`,
    order: 'id',
  },
  order_items: {
    row: `concat_ws('|', id, order_id, product_id, quantity, unit_price::text)`,
    order: 'id',
  },
};

export interface DatasetChecksum {
  tables: Record<ChecksumTable, { rows: number; sha256: string }>;
  /** sha256 over "table:rows:sha256" lines, in CHECKSUM_TABLES order. */
  combined: string;
}

function digest(lines: string[]): string {
  const hash = createHash('sha256');
  lines.forEach((line, index) => hash.update(index === 0 ? line : `\n${line}`));
  return hash.digest('hex');
}

function combine(tables: DatasetChecksum['tables']): string {
  return digest(CHECKSUM_TABLES.map((t) => `${t}:${tables[t].rows}:${tables[t].sha256}`));
}

const byKey =
  <T>(key: (row: T) => string) =>
  (a: T, b: T) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;

/** Checksum computed from the in-memory generated dataset. */
export function checksumDataset(dataset: Dataset): DatasetChecksum {
  const table = <T>(rows: T[], key: (row: T) => string, text: (row: T) => string) => {
    const sorted = [...rows].sort(byKey(key));
    return { rows: sorted.length, sha256: digest(sorted.map(text)) };
  };
  const tables: DatasetChecksum['tables'] = {
    users: table(
      dataset.users,
      (r) => r.id,
      (r) => [r.id, r.email, r.passwordHash, r.role, r.createdAt].join('|'),
    ),
    products: table(
      dataset.products,
      (r) => r.id,
      (r) => [r.id, r.sku, r.name, r.category, r.price, String(r.isActive), r.createdAt].join('|'),
    ),
    inventory: table(
      dataset.inventory,
      (r) => r.productId,
      (r) => [r.productId, r.availableQuantity, r.reservedQuantity, r.version].join('|'),
    ),
    orders: table(
      dataset.orders,
      (r) => r.id,
      (r) =>
        [
          r.id,
          r.userId,
          r.status,
          r.paymentStatus,
          r.totalAmount,
          r.idempotencyKey,
          r.createdAt,
          r.updatedAt,
        ].join('|'),
    ),
    order_items: table(
      dataset.orderItems,
      (r) => r.id,
      (r) => [r.id, r.orderId, r.productId, r.quantity, r.unitPrice].join('|'),
    ),
  };
  return { tables, combined: combine(tables) };
}

/**
 * Checksum computed inside PostgreSQL. Rows are streamed in key order (UUID
 * ordering in PG equals lowercase-hex string ordering) and hashed in Node,
 * so large tables never build one giant string in the database.
 */
export async function checksumDatabase(client: pg.ClientBase): Promise<DatasetChecksum> {
  const tables = {} as DatasetChecksum['tables'];
  for (const name of CHECKSUM_TABLES) {
    const { row, order } = DB_ROW_SQL[name];
    // Table/column SQL comes from the constant map above, never from input.
    const result = await client.query<{ r: string }>(
      `SELECT ${row} AS r FROM ${name} ORDER BY ${order}`,
    );
    tables[name] = { rows: result.rows.length, sha256: digest(result.rows.map((x) => x.r)) };
  }
  return { tables, combined: combine(tables) };
}
