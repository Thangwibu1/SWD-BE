import type { Database } from '../shared/database/db.js';
import type { CatalogApi, Page, Product } from '../shared/domain/types.js';
import { DomainError } from '../shared/errors/domain-errors.js';
import type { ProductCache } from './product-cache.js';

/**
 * Catalog module — product list, search and detail.
 * When a ProductCache is provided (A02+), reads go through cache first.
 */
export function createCatalogModule(db: Database, cache: ProductCache): CatalogApi {
  return {
    async list(query): Promise<Page<Product>> {
      const { category, page, pageSize } = query;
      const cacheKey = `products:list:${category ?? ''}:${page}:${pageSize}`;
      const cached = await cache.getPage(cacheKey);
      if (cached) return cached;

      const offset = (page - 1) * pageSize;
      let whereClause = 'WHERE is_active = true';
      const countParams: unknown[] = [];
      const dataParams: unknown[] = [pageSize, offset];
      if (category !== null) {
        countParams.push(category);
        dataParams.push(category);
        whereClause += ` AND category = $${countParams.length}`;
      }
      const countRes = await db.query<{ cnt: string }>(
        'catalog.list.count',
        `SELECT count(*)::text AS cnt FROM products ${whereClause}`,
        countParams,
      );
      const total = Number(countRes.rows[0]?.cnt ?? 0);
      // Rebuild where with correct param index for the data query ($1=limit, $2=offset).
      let dataWhere = 'WHERE is_active = true';
      if (category !== null) {
        dataWhere += ' AND category = $3';
      }
      const dataRes = await db.query<ProductRow>(
        'catalog.list',
        `SELECT id, sku, name, category, price, is_active
         FROM products ${dataWhere}
         ORDER BY created_at DESC, id
         LIMIT $1 OFFSET $2`,
        dataParams,
      );
      const result: Page<Product> = {
        items: dataRes.rows.map(toProduct),
        page,
        pageSize,
        total,
      };
      await cache.setPage(cacheKey, result);
      return result;
    },

    async search(query): Promise<Page<Product>> {
      const { q, page, pageSize } = query;
      const offset = (page - 1) * pageSize;
      const pattern = `%${q}%`;
      const countRes = await db.query<{ cnt: string }>(
        'catalog.search.count',
        `SELECT count(*)::text AS cnt FROM products
         WHERE is_active = true AND (name ILIKE $1 OR sku ILIKE $1)`,
        [pattern],
      );
      const total = Number(countRes.rows[0]?.cnt ?? 0);
      const dataRes = await db.query<ProductRow>(
        'catalog.search',
        `SELECT id, sku, name, category, price, is_active
         FROM products
         WHERE is_active = true AND (name ILIKE $1 OR sku ILIKE $1)
         ORDER BY created_at DESC, id
         LIMIT $2 OFFSET $3`,
        [pattern, pageSize, offset],
      );
      return { items: dataRes.rows.map(toProduct), page, pageSize, total };
    },

    async get(productId): Promise<Product> {
      const cached = await cache.getProduct(productId);
      if (cached) return cached;

      const res = await db.query<ProductRow>(
        'catalog.get',
        `SELECT id, sku, name, category, price, is_active FROM products WHERE id = $1`,
        [productId],
      );
      const row = res.rows[0];
      if (!row) throw new DomainError('PRODUCT_NOT_FOUND');
      const product = toProduct(row);
      await cache.setProduct(productId, product);
      return product;
    },
  };
}

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  category: string;
  price: string;
  is_active: boolean;
}

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    category: row.category,
    price: row.price,
    isActive: row.is_active,
  };
}
