import type { Cart, CartApi, CartLine } from '../shared/domain/types.js';
import { DomainError } from '../shared/errors/domain-errors.js';

/**
 * Cart is separate from business tables. Runtime stores are shared PostgreSQL
 * or Redis; memory is retained for isolated module tests.
 */
export interface CartStore {
  get(userId: string): Promise<CartLine[]>;
  set(userId: string, items: CartLine[]): Promise<void>;
  clear(userId: string): Promise<void>;
  upsert?(userId: string, productId: string, quantity: number): Promise<CartLine[]>;
  remove?(userId: string, productId: string): Promise<CartLine[]>;
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
      if (store.upsert) return { userId, items: await store.upsert(userId, productId, quantity) };
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
      if (store.remove) return { userId, items: await store.remove(userId, productId) };
      const items = await store.get(userId);
      const index = items.findIndex((i) => i.productId === productId);
      if (index < 0) throw new DomainError('CART_ITEM_NOT_FOUND');
      items.splice(index, 1);
      await store.set(userId, items);
      return { userId, items };
    },
  };
}
