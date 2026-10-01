import { DomainError } from '../errors/domain-errors.js';
import type { CheckoutItem } from './types.js';

export const ORDER_STATUSES = ['PENDING', 'CONFIRMED', 'CANCELLED', 'FAILED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_STATUSES = ['NOT_REQUIRED', 'PENDING', 'PAID', 'FAILED', 'REFUNDED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * Order state machine shared by every family. Nothing ever transitions back
 * to PENDING (INV-07); CANCELLED and FAILED are terminal.
 */
const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ['CONFIRMED', 'FAILED', 'CANCELLED'],
  CONFIRMED: ['CANCELLED'],
  CANCELLED: [],
  FAILED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Statuses from which `to` is reachable; used for guarded SQL updates. */
export function allowedFrom(to: OrderStatus): OrderStatus[] {
  return ORDER_STATUSES.filter((from) => canTransition(from, to));
}

/** Only confirmed (paid) orders can be cancelled; stock is then released (INV-05). */
export function isCancellable(status: OrderStatus): boolean {
  return status === 'CONFIRMED';
}

export const MAX_CHECKOUT_LINES = 50;

/** Rejects duplicate product lines (order_items has UNIQUE(order_id, product_id)). */
export function assertUniqueItems(items: readonly CheckoutItem[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.productId)) {
      throw new DomainError('VALIDATION_FAILED', { field: 'items', reason: 'duplicate productId', productId: item.productId });
    }
    seen.add(item.productId);
  }
}

/**
 * Idempotency replay check without an extra column (the SUT keeps 5 tables):
 * a key is a replay only if user and item set are identical to the stored order.
 */
export function isSameCheckout(
  existing: { userId: string; items: ReadonlyArray<{ productId: string; quantity: number }> },
  request: { userId: string; items: readonly CheckoutItem[] },
): boolean {
  if (existing.userId !== request.userId || existing.items.length !== request.items.length) return false;
  const stored = new Map(existing.items.map((i) => [i.productId, i.quantity]));
  return request.items.every((i) => stored.get(i.productId) === i.quantity);
}
