import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectRedis, RedisCartStore, RedisProductCache, type RedisClient } from '../../src/sut/monolith/redis-cache.js';
import { createLogger } from '../../src/utils/logger.js';
import { pinnedVersions } from './helpers/dev-postgres.js';

describe('A02+ Redis cache and stateless cart', () => {
  const container = 'arch-eval-test-redis-cache';
  let client: RedisClient;
  beforeAll(async () => {
    await execa('docker', ['rm', '-f', container], { reject: false });
    await execa('docker', ['run', '-d', '--name', container, '-p', '127.0.0.1::6379',
      `redis:${pinnedVersions().REDIS_VERSION}`]);
    const port = (await execa('docker', ['port', container, '6379/tcp'])).stdout.split(':').pop()?.trim();
    if (!port) throw new Error('Redis test port was not assigned');
    client = await connectRedis(`redis://127.0.0.1:${port}`, createLogger('redis-test', 'silent'));
  }, 30_000);
  afterAll(async () => {
    await client?.close();
    await execa('docker', ['rm', '-f', container], { reject: false });
  });

  it('expires product entries at the configured TTL', async () => {
    const cache = new RedisProductCache(client, 1);
    const product = { id: 'p1', sku: 'SKU-1', name: 'Product', category: 'test', price: '1.00', isActive: true };
    await cache.setProduct(product.id, product);
    expect(await cache.getProduct(product.id)).toEqual(product);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await cache.getProduct(product.id)).toBeNull();
  });

  it('shares cart state between independent service instances', async () => {
    const writer = new RedisCartStore(client);
    const reader = new RedisCartStore(client);
    await writer.set('user-1', [{ productId: 'p1', quantity: 3 }]);
    expect(await reader.get('user-1')).toEqual([{ productId: 'p1', quantity: 3 }]);
    await reader.clear('user-1');
    expect(await writer.get('user-1')).toEqual([]);
  });
});
