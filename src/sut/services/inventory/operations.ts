import type { Database } from '../../shared/database/db.js';
import { DomainError } from '../../shared/errors/domain-errors.js';
import { createInventoryModule } from '../../monolith/inventory-module.js';
import { assertUniqueItems, MAX_CHECKOUT_LINES } from '../../shared/domain/order-rules.js';

export type InventoryAction = 'reserve' | 'commit' | 'release';
export type StockItem = { productId: string; quantity: number };

/** Durable idempotency includes a release tombstone for an ambiguous reserve. */
export async function applyInventoryOperation(db: Database, action: InventoryAction, orderId: string, items: StockItem[]): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(orderId) || !Array.isArray(items) ||
      !items.length || items.length > MAX_CHECKOUT_LINES || items.some(i =>
        !i || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(i.productId) || !Number.isSafeInteger(i.quantity) || i.quantity <= 0)) {
    throw new DomainError('VALIDATION_FAILED');
  }
  assertUniqueItems(items);
  const normalized = items.map(i => ({ productId: i.productId, quantity: i.quantity }))
    .sort((a, b) => a.productId.localeCompare(b.productId));
  const module = createInventoryModule(db);
  await db.transaction(async tx => {
    await tx.query('inventory.operation.lock', 'SELECT pg_advisory_xact_lock(hashtextextended($1,1))', [orderId]);
    const previous = await tx.query<{ state: string; items: StockItem[] }>('inventory.operation.get',
      'SELECT state,items FROM reliability.inventory_operations WHERE order_id=$1', [orderId]);
    const row = previous.rows[0];
    if (row && (row.items.length !== normalized.length || row.items.some((item, index) =>
      item.productId !== normalized[index]?.productId || item.quantity !== normalized[index]?.quantity))) {
      throw new DomainError('IDEMPOTENCY_KEY_CONFLICT');
    }
    if (action === 'reserve') {
      if (row?.state === 'RELEASED') throw new DomainError('ORDER_NOT_CANCELLABLE');
      if (row) return;
      await module.reserveStock(tx, normalized);
    } else if (action === 'commit') {
      if (!row || row.state === 'RELEASED') throw new DomainError('ORDER_NOT_CANCELLABLE');
      if (row.state === 'COMMITTED') return;
      await module.commitStock(tx, normalized);
    } else {
      if (row?.state === 'RELEASED') return;
      if (row) await module.releaseStock(tx, normalized);
    }
    const state = action === 'reserve' ? 'RESERVED' : action === 'commit' ? 'COMMITTED' : 'RELEASED';
    await tx.query('inventory.operation.record', `INSERT INTO reliability.inventory_operations(order_id,items,state)
      VALUES ($1,$2,$3) ON CONFLICT(order_id) DO UPDATE SET state=excluded.state`, [orderId, JSON.stringify(normalized), state]);
  });
}
