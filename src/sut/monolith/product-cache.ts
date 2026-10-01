import type { Page, Product } from '../shared/domain/types.js';

/**
 * Product cache abstraction.
 * - NullProductCache: no-op pass-through for A01.
 * - RedisProductCache: Redis-backed TTL cache for A02+.
 */
export interface ProductCache {
  getProduct(id: string): Promise<Product | null>;
  setProduct(id: string, product: Product): Promise<void>;
  getPage(key: string): Promise<Page<Product> | null>;
  setPage(key: string, page: Page<Product>): Promise<void>;
  invalidate(id: string): Promise<void>;
}

/** No-op cache used by A01. Every read hits the database. */
export class NullProductCache implements ProductCache {
  async getProduct(): Promise<null> {
    return null;
  }
  async setProduct(): Promise<void> {
    /* no-op */
  }
  async getPage(): Promise<null> {
    return null;
  }
  async setPage(): Promise<void> {
    /* no-op */
  }
  async invalidate(): Promise<void> {
    /* no-op */
  }
}
