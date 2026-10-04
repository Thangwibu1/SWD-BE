import { createHash } from 'node:crypto';
import { Prng, ZipfSampler } from './prng.js';

export const DEFAULT_SEED = 20261001;

export type DatasetProfileName = 'pilot' | 'main' | 'capacity';

export interface DatasetProfile {
  name: DatasetProfileName;
  users: number;
  products: number;
  orders: number;
  itemsPerOrder: number;
  inventoryPerProduct?: number;
}

// Sizes from guide section 6.2. items = orders * itemsPerOrder.
export const DATASET_PROFILES: Record<DatasetProfileName, DatasetProfile> = {
  pilot: { name: 'pilot', users: 1_000, products: 2_000, orders: 5_000, itemsPerOrder: 3 },
  main: { name: 'main', users: 50_000, products: 20_000, orders: 200_000, itemsPerOrder: 3 },
  capacity: { name: 'capacity', users: 50_000, products: 20_000, orders: 200_000, itemsPerOrder: 3,
    inventoryPerProduct: 10_000_000 },
};

export const ZIPF_EXPONENT = 1.07;
export const HOT_SKU_COUNT = 20;
const BASE_TIME_MS = Date.UTC(2026, 0, 1);
const CATEGORIES = [
  'electronics',
  'books',
  'home',
  'garden',
  'toys',
  'sports',
  'beauty',
  'grocery',
  'fashion',
  'shoes',
  'office',
  'pets',
  'automotive',
  'music',
  'health',
  'baby',
  'tools',
  'outdoor',
  'kitchen',
  'gaming',
] as const;
const ADJECTIVES = [
  'classic',
  'smart',
  'eco',
  'compact',
  'premium',
  'ultra',
  'mini',
  'pro',
  'basic',
  'deluxe',
];
const NOUNS = [
  'lamp',
  'bottle',
  'speaker',
  'jacket',
  'chair',
  'notebook',
  'charger',
  'backpack',
  'mug',
  'watch',
  'kettle',
  'headset',
];

/** Mock credential: every seeded user logs in with this password. Not a secret. */
export const SEED_USER_PASSWORD = 'benchmark';

/** Deterministic mock password hash; benchmark data only, never real credentials. */
export function mockPasswordHash(email: string, password: string): string {
  return `mock-sha256$${createHash('sha256').update(`${email.toLowerCase()}:${password}`).digest('hex')}`;
}

export interface UserRow {
  id: string;
  email: string;
  passwordHash: string;
  role: 'customer' | 'admin';
  createdAt: string;
}
export interface ProductRow {
  id: string;
  sku: string;
  name: string;
  category: string;
  price: string;
  isActive: boolean;
  createdAt: string;
}
export interface InventoryRow {
  productId: string;
  availableQuantity: number;
  reservedQuantity: number;
  version: number;
}
export interface OrderRow {
  id: string;
  userId: string;
  status: 'CONFIRMED' | 'CANCELLED' | 'FAILED';
  paymentStatus: 'PAID' | 'REFUNDED' | 'FAILED';
  totalAmount: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}
export interface OrderItemRow {
  id: string;
  orderId: string;
  productId: string;
  quantity: number;
  unitPrice: string;
}

export interface Dataset {
  profile: DatasetProfile;
  seed: number;
  users: UserRow[];
  products: ProductRow[];
  inventory: InventoryRow[];
  orders: OrderRow[];
  orderItems: OrderItemRow[];
  /** Product IDs ordered by popularity rank (rank 0 = most popular). */
  popularity: string[];
}

const iso = (offsetMs: number) => new Date(BASE_TIME_MS + offsetMs).toISOString();
const cents = (value: number) => (value / 100).toFixed(2);

/**
 * Generates the full dataset in memory from a seed. Every value, including
 * UUIDs and timestamps, comes from the PRNG so output is byte-stable.
 */
export function generateDataset(profile: DatasetProfile, seed = DEFAULT_SEED): Dataset {
  const prng = new Prng(seed);

  const users: UserRow[] = [];
  for (let i = 0; i < profile.users; i += 1) {
    const email = `user${String(i).padStart(6, '0')}@bench.example`;
    users.push({
      id: prng.uuid(),
      email,
      passwordHash: mockPasswordHash(email, SEED_USER_PASSWORD),
      role: i < 5 ? 'admin' : 'customer',
      createdAt: iso(prng.int(0, 180) * 86_400_000),
    });
  }

  const products: ProductRow[] = [];
  const inventory: InventoryRow[] = [];
  const priceCents: number[] = [];
  for (let i = 0; i < profile.products; i += 1) {
    const id = prng.uuid();
    const category = CATEGORIES[i % CATEGORIES.length] as string;
    const adjective = ADJECTIVES[prng.int(0, ADJECTIVES.length - 1)] as string;
    const noun = NOUNS[prng.int(0, NOUNS.length - 1)] as string;
    const price = prng.int(199, 49_999);
    priceCents.push(price);
    products.push({
      id,
      sku: `SKU-${String(i).padStart(6, '0')}`,
      name: `${adjective} ${noun} ${category} ${i}`,
      category,
      price: cents(price),
      // 2% inactive products exercise the is_active filter.
      isActive: prng.next() >= 0.02,
      createdAt: iso(prng.int(0, 180) * 86_400_000),
    });
    inventory.push({
      productId: id,
      availableQuantity: profile.inventoryPerProduct ?? prng.int(50, 500),
      reservedQuantity: 0,
      version: 0,
    });
  }

  // Popularity: a seeded permutation maps Zipf rank -> product index, so the
  // hot set is not simply the first SKUs.
  const rankToIndex = prng.shuffle(products.map((_, index) => index));
  const zipf = new ZipfSampler(profile.products, ZIPF_EXPONENT);

  const orders: OrderRow[] = [];
  const orderItems: OrderItemRow[] = [];
  for (let i = 0; i < profile.orders; i += 1) {
    const orderId = prng.uuid();
    const user = users[prng.int(0, users.length - 1)] as UserRow;
    const chosen = new Set<number>();
    while (chosen.size < profile.itemsPerOrder) {
      chosen.add(rankToIndex[zipf.sample(prng)] as number);
    }
    let totalCents = 0;
    for (const productIndex of [...chosen].sort((a, b) => a - b)) {
      const quantity = prng.int(1, 3);
      const unit = priceCents[productIndex] as number;
      totalCents += unit * quantity;
      orderItems.push({
        id: prng.uuid(),
        orderId,
        productId: (products[productIndex] as ProductRow).id,
        quantity,
        unitPrice: cents(unit),
      });
    }
    // Historical orders are terminal so they never interfere with live runs.
    const roll = prng.next();
    const [status, paymentStatus] =
      roll < 0.8
        ? (['CONFIRMED', 'PAID'] as const)
        : roll < 0.9
          ? (['CANCELLED', 'REFUNDED'] as const)
          : (['FAILED', 'FAILED'] as const);
    const createdMs = prng.int(0, 270) * 86_400_000 + prng.int(0, 86_399) * 1000;
    orders.push({
      id: orderId,
      userId: user.id,
      status,
      paymentStatus,
      totalAmount: cents(totalCents),
      idempotencyKey: `seed-${seed}-${i}`,
      createdAt: iso(createdMs),
      updatedAt: iso(createdMs + prng.int(1, 3600) * 1000),
    });
  }

  const popularity = rankToIndex.map((index) => (products[index] as ProductRow).id);
  return { profile, seed, users, products, inventory, orders, orderItems, popularity };
}
