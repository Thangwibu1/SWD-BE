import type { Database, SqlExecutor } from '../shared/database/db.js';
import type { InventoryApi, InventoryView } from '../shared/domain/types.js';
import { DomainError } from '../shared/errors/domain-errors.js';

export function createInventoryModule(db: Database): InventoryApi & InventoryTxOps {
  return {
    async get(productId): Promise<InventoryView> {
      const res = await db.query<InventoryRow>(
        'inventory.get',
        `SELECT product_id, available_quantity, reserved_quantity FROM inventory WHERE product_id = $1`,
        [productId],
      );
      const row = res.rows[0];
      if (!row) throw new DomainError('PRODUCT_NOT_FOUND');
      return toView(row);
    },

    async reserveStock(tx, items): Promise<void> {
      for (const item of items) {
        const res = await tx.query<InventoryRow>(
          'inventory.lock',
          `SELECT product_id, available_quantity, reserved_quantity, version
           FROM inventory WHERE product_id = $1 FOR UPDATE`,
          [item.productId],
        );
        const row = res.rows[0];
        if (!row) throw new DomainError('PRODUCT_NOT_FOUND');
        if (row.available_quantity < item.quantity) {
          throw new DomainError('INSUFFICIENT_STOCK', {
            productId: item.productId,
            requested: item.quantity,
            available: row.available_quantity,
          });
        }
        await tx.query(
          'inventory.reserve',
          `UPDATE inventory
           SET available_quantity = available_quantity - $2,
               reserved_quantity = reserved_quantity + $2,
               version = version + 1
           WHERE product_id = $1 AND version = $3`,
          [item.productId, item.quantity, row.version],
        );
      }
    },

    async releaseStock(tx, items): Promise<void> {
      for (const item of items) {
        await tx.query(
          'inventory.release',
          `UPDATE inventory
           SET available_quantity = available_quantity + $2,
               reserved_quantity = GREATEST(0, reserved_quantity - $2),
               version = version + 1
           WHERE product_id = $1`,
          [item.productId, item.quantity],
        );
      }
    },

    async commitStock(tx, items): Promise<void> {
      for (const item of items) {
        await tx.query(
          'inventory.commit',
          `UPDATE inventory
           SET reserved_quantity = GREATEST(0, reserved_quantity - $2),
               version = version + 1
           WHERE product_id = $1`,
          [item.productId, item.quantity],
        );
      }
    },
  };
}

/**
 * Transactional inventory operations used by the monolith's checkout.
 * These accept a SqlExecutor (transaction client) so the order and inventory
 * changes share one transaction — the key advantage of a monolith.
 */
export interface InventoryTxOps {
  /** Lock rows FOR UPDATE and decrement available, increment reserved. */
  reserveStock(tx: SqlExecutor, items: ReadonlyArray<{ productId: string; quantity: number }>): Promise<void>;
  /** Release reserved stock back to available (cancel / payment-fail). */
  releaseStock(tx: SqlExecutor, items: ReadonlyArray<{ productId: string; quantity: number }>): Promise<void>;
  /** Move stock from reserved to sold (payment succeeded). */
  commitStock(tx: SqlExecutor, items: ReadonlyArray<{ productId: string; quantity: number }>): Promise<void>;
}

interface InventoryRow {
  product_id: string;
  available_quantity: number;
  reserved_quantity: number;
  version?: number;
}

function toView(row: InventoryRow): InventoryView {
  return {
    productId: row.product_id,
    availableQuantity: row.available_quantity,
    reservedQuantity: row.reserved_quantity,
  };
}
