import { describe, expect, it } from 'vitest';
import { checksumDataset } from '../../src/sut/shared/database/seed/checksum.js';
import {
  DATASET_PROFILES,
  DEFAULT_SEED,
  generateDataset,
} from '../../src/sut/shared/database/seed/dataset.js';
import type { DatasetProfile } from '../../src/sut/shared/database/seed/dataset.js';
import { Prng, ZipfSampler } from '../../src/sut/shared/database/seed/prng.js';

const PILOT_CHECKSUM = '7a92818881f7a45447b856ab3fc2d9b9d70dc59dbbca150875ed15916141633e';
const small: DatasetProfile = {
  name: 'pilot',
  users: 50,
  products: 100,
  orders: 200,
  itemsPerOrder: 3,
};

describe('dataset generator', () => {
  it('uses the spec default seed and pilot/main sizes', () => {
    expect(DEFAULT_SEED).toBe(20261001);
    const p = DATASET_PROFILES.pilot;
    expect([p.users, p.products, p.orders, p.orders * p.itemsPerOrder]).toEqual([
      1000, 2000, 5000, 15000,
    ]);
    const m = DATASET_PROFILES.main;
    expect([m.users, m.products, m.orders, m.orders * m.itemsPerOrder]).toEqual([
      50000, 20000, 200000, 600000,
    ]);
  });

  it('is deterministic for the same seed and differs for another seed', () => {
    const a = checksumDataset(generateDataset(small, 1));
    const b = checksumDataset(generateDataset(small, 1));
    const c = checksumDataset(generateDataset(small, 2));
    expect(a.combined).toBe(b.combined);
    expect(a.combined).not.toBe(c.combined);
  });

  it('produces the pilot row counts and a stable pilot checksum', () => {
    const dataset = generateDataset(DATASET_PROFILES.pilot);
    const checksum = checksumDataset(dataset);
    expect(checksum.tables.users.rows).toBe(1000);
    expect(checksum.tables.products.rows).toBe(2000);
    expect(checksum.tables.inventory.rows).toBe(2000);
    expect(checksum.tables.orders.rows).toBe(5000);
    expect(checksum.tables.order_items.rows).toBe(15000);
    // Golden value: any change to the generator must be deliberate (and
    // re-snapshotted), because restore verification compares against it.
    expect(checksum.combined).toBe(PILOT_CHECKSUM);
  });

  it('keeps business invariants in seeded data', () => {
    const d = generateDataset(small, 7);
    const price = new Map(d.products.map((p) => [p.id, Math.round(Number(p.price) * 100)]));
    const itemsByOrder = new Map<string, number>();
    const pairs = new Set<string>();
    for (const item of d.orderItems) {
      expect(item.quantity).toBeGreaterThan(0);
      expect(Math.round(Number(item.unitPrice) * 100)).toBe(price.get(item.productId));
      const pair = `${item.orderId}:${item.productId}`;
      expect(pairs.has(pair)).toBe(false); // UNIQUE(order_id, product_id)
      pairs.add(pair);
      itemsByOrder.set(
        item.orderId,
        (itemsByOrder.get(item.orderId) ?? 0) + item.quantity * Number(price.get(item.productId)),
      );
    }
    for (const order of d.orders) {
      // INV-03: total_amount = sum(quantity * unit_price)
      expect(Math.round(Number(order.totalAmount) * 100)).toBe(itemsByOrder.get(order.id));
      expect(['CONFIRMED', 'CANCELLED', 'FAILED']).toContain(order.status);
    }
    expect(new Set(d.orders.map((o) => o.idempotencyKey)).size).toBe(d.orders.length);
    expect(new Set(d.users.map((u) => u.email.toLowerCase())).size).toBe(d.users.length);
    for (const inv of d.inventory) expect(inv.availableQuantity).toBeGreaterThanOrEqual(0);
  });

  it('skews product popularity Zipf-like (top 1% of SKUs gets far more than 1% of items)', () => {
    const d = generateDataset(DATASET_PROFILES.pilot);
    const hot = new Set(d.popularity.slice(0, 20));
    const hotShare = d.orderItems.filter((i) => hot.has(i.productId)).length / d.orderItems.length;
    expect(hotShare).toBeGreaterThan(0.2);
  });
});

describe('prng', () => {
  it('generates valid v4 UUIDs', () => {
    const prng = new Prng(42);
    for (let i = 0; i < 100; i += 1) {
      expect(prng.uuid()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it('zipf rank 0 is the most frequent', () => {
    const prng = new Prng(1);
    const zipf = new ZipfSampler(100, 1.07);
    const counts = new Array<number>(100).fill(0);
    for (let i = 0; i < 20_000; i += 1) counts[zipf.sample(prng)]! += 1;
    expect(counts[0]).toBe(Math.max(...counts));
  });
});
