import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { createClient } from 'redis';
import { randomUUID } from 'node:crypto';
import { pinnedVersions } from './helpers/dev-postgres.js';
import { createCartModule } from '../../src/sut/monolith/cart-module.js';
import { RedisCartStore, type RedisClient } from '../../src/sut/monolith/redis-cache.js';

describe('Redis cart mutations shared by independent replicas', () => {
  const container = `arch-eval-test-cart-${randomUUID().slice(0, 8)}`;
  const clients: RedisClient[] = [];
  beforeAll(async () => {
    await execa('docker', ['run', '-d', '--name', container, '-p', '127.0.0.1::6379', `redis:${pinnedVersions().REDIS_VERSION}`]);
    const { stdout } = await execa('docker', ['port', container, '6379/tcp']);
    const port = stdout.trim().split(':').pop();
    for (let i = 0; i < 2; i++) {
      const client = createClient({ url: `redis://127.0.0.1:${port}` }) as RedisClient;
      client.on('error', () => undefined);
      await client.connect();
      clients.push(client);
    }
  }, 30_000);
  afterAll(async () => {
    await Promise.all(clients.map(c => c.quit()));
    await execa('docker', ['rm', '-f', container], { reject: false });
  });
  it('retains all concurrent fields and does not resurrect removed items', async () => {
    const replicas = clients.map(c => createCartModule(new RedisCartStore(c)));
    const user = randomUUID();
    const products = Array.from({ length: 24 }, () => randomUUID());
    await Promise.all(products.map((p, i) => replicas[i % 2]!.upsert(user, p, i + 1)));
    expect((await replicas[1]!.get(user)).items).toHaveLength(24);
    await Promise.all(products.map((p, i) => i % 2
      ? replicas[0]!.upsert(user, p, 100)
      : replicas[1]!.remove(user, p)));
    const remaining = (await replicas[0]!.get(user)).items;
    expect(remaining).toHaveLength(12);
    expect(remaining.every(p => p.quantity === 100)).toBe(true);
    await expect(replicas[0]!.remove(user, products[0]!)).rejects.toMatchObject({ code: 'CART_ITEM_NOT_FOUND' });
  });
});
