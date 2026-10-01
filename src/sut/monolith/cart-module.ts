import type { Cart, CartApi, CartLine } from '../shared/domain/types.js';
import { DomainError } from '../shared/errors/domain-errors.js';

/**
 * Abstract cart store — MemoryCartStore for A01, RedisCartStore for A02+.
 * Cart is NOT one of the 5 SUT business tables; it lives in Redis or memory
 * as specified by the guide (section 6).
 */
export interface CartStore {
  get(userId: string): Promise<CartLine[]>;
  set(userId: string, items: CartLine[]): Promise<void>;
  clear(userId: string): Promise<void>;
}

export class MemoryCartStore implements CartStore {
  private readonly data = new Map<string, CartLine[]>();

  async get(userId: string): Promise<CartLine[]> {
    return structuredClone(this.data.get(userId) ?? []);
  }

  async set(userId: string, items: CartLine[]): Promise<void> {
    if (items.length === 0) {
      this.data.delete(userId);
    } else {
      this.data.set(userId, structuredClone(items));
    }
  }

  async clear(userId: string): Promise<void> {
    this.data.delete(userId);
  }
}

export function createCartModule(store: CartStore): CartApi {
  return {
    async get(userId): Promise<Cart> {
      return { userId, items: await store.get(userId) };
    },

    async upsert(userId, productId, quantity): Promise<Cart> {
      const items = await store.get(userId);
      const existing = items.find((i) => i.productId === productId);
      if (existing) {
        existing.quantity = quantity;
      } else {
        items.push({ productId, quantity });
      }
      await store.set(userId, items);
      return { userId, items };
    },

    async remove(userId, productId): Promise<Cart> {
      const items = await store.get(userId);
      const index = items.findIndex((i) => i.productId === productId);
      if (index < 0) throw new DomainError('CART_ITEM_NOT_FOUND');
      items.splice(index, 1);
      await store.set(userId, items);
      return { userId, items };
    },
  };
}
