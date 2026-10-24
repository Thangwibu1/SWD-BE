import { createClient } from 'redis';
import type { RedisClientType } from 'redis';
import type { Page, Product } from '../shared/domain/types.js';
import type { ProductCache } from './product-cache.js';
import type { CartStore } from './cart-module.js';
import type { CartLine } from '../shared/domain/types.js';
import type { Logger } from '../shared/../../utils/logger.js';
import { getSutMetrics } from '../shared/observability/metrics.js';
import { DomainError } from '../shared/errors/domain-errors.js';

const DEFAULT_TTL_SECONDS = 60;

export type RedisClient = RedisClientType;

export async function connectRedis(url: string, logger: Logger): Promise<RedisClient> {
  const client: RedisClient = createClient({ url }) as RedisClient;
  client.on('error', (err: unknown) => logger.warn({ err }, 'Redis client error'));
  await client.connect();
  return client;
}

// ─── Product cache ─────────────────────────────────────────────────────

export class RedisProductCache implements ProductCache {
  constructor(
    private readonly client: RedisClient,
    private readonly ttl = DEFAULT_TTL_SECONDS,
  ) {}

  async getProduct(id: string): Promise<Product | null> {
    const started = process.hrtime.bigint();
    const raw = await this.client.get(`product:${id}`);
    getSutMetrics().cacheDuration.observe(Number(process.hrtime.bigint() - started) / 1e9);
    getSutMetrics().cacheRequests.inc({ result: raw ? 'hit' : 'miss' });
    return raw ? (JSON.parse(raw) as Product) : null;
  }

  async setProduct(id: string, product: Product): Promise<void> {
    const started = process.hrtime.bigint();
    await this.client.set(`product:${id}`, JSON.stringify(product), { EX: this.ttl });
    getSutMetrics().cacheDuration.observe(Number(process.hrtime.bigint() - started) / 1e9);
  }

  async getPage(key: string): Promise<Page<Product> | null> {
    const started = process.hrtime.bigint();
    const raw = await this.client.get(`page:${key}`);
    getSutMetrics().cacheDuration.observe(Number(process.hrtime.bigint() - started) / 1e9);
    getSutMetrics().cacheRequests.inc({ result: raw ? 'hit' : 'miss' });
    return raw ? (JSON.parse(raw) as Page<Product>) : null;
  }

  async setPage(key: string, page: Page<Product>): Promise<void> {
    const started = process.hrtime.bigint();
    await this.client.set(`page:${key}`, JSON.stringify(page), { EX: this.ttl });
    getSutMetrics().cacheDuration.observe(Number(process.hrtime.bigint() - started) / 1e9);
  }

  async invalidate(id: string): Promise<void> {
    const started = process.hrtime.bigint();
    await this.client.del(`product:${id}`);
    getSutMetrics().cacheDuration.observe(Number(process.hrtime.bigint() - started) / 1e9);
  }
}

// ─── Cart store ────────────────────────────────────────────────────────

/**
 * Redis-backed cart store for A02+ (guide §10.1: when running multiple
 * replicas, cart must be in Redis and API stateless).
 *
 * Each user's cart is stored as a Redis Hash (field = productId, value = quantity).
 */
export class RedisCartStore implements CartStore {
  constructor(private readonly client: RedisClient) {}

  async upsert(userId: string, productId: string, quantity: number): Promise<CartLine[]> {
    await this.client.hSet(`cart:${userId}`, productId, String(quantity));
    return this.get(userId);
  }

  async remove(userId: string, productId: string): Promise<CartLine[]> {
    const removed = await this.client.hDel(`cart:${userId}`, productId);
    if (!removed) throw new DomainError('CART_ITEM_NOT_FOUND');
    return this.get(userId);
  }

  async get(userId: string): Promise<CartLine[]> {
    const hash = await this.client.hGetAll(`cart:${userId}`);
    return Object.entries(hash).map(([productId, qty]) => ({
      productId,
      quantity: Number(qty),
    }));
  }

  async set(userId: string, items: CartLine[]): Promise<void> {
    const key = `cart:${userId}`;
    const transaction = this.client.multi().del(key);
    if (items.length > 0) {
      const fields: Record<string, string> = {};
      for (const item of items) {
        fields[item.productId] = String(item.quantity);
      }
      transaction.hSet(key, fields);
    }
    await transaction.exec();
  }

  async clear(userId: string): Promise<void> {
    await this.client.del(`cart:${userId}`);
  }
}
