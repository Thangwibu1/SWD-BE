import type { PaymentMode } from '../contracts/routes.js';
import type { OrderStatus, PaymentStatus } from './order-rules.js';

/** DTOs mirror schemas/sut-openapi.json component schemas exactly. */
export interface Product {
  id: string;
  sku: string;
  name: string;
  category: string;
  price: string;
  isActive: boolean;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface InventoryView {
  productId: string;
  availableQuantity: number;
  reservedQuantity: number;
}

export interface CartLine {
  productId: string;
  quantity: number;
}

export interface Cart {
  userId: string;
  items: CartLine[];
}

export interface CheckoutItem {
  productId: string;
  quantity: number;
}

export interface CheckoutRequest {
  userId: string;
  items: CheckoutItem[];
  paymentMode: PaymentMode;
}

export interface OrderItem {
  productId: string;
  quantity: number;
  unitPrice: string;
}

export interface Order {
  id: string;
  userId: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  totalAmount: string;
  items: OrderItem[];
  createdAt: string;
  updatedAt: string;
}

export interface OrderSummary {
  id: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  totalAmount: string;
  createdAt: string;
}

export interface LoginResult {
  userId: string;
  token: string;
  role: 'customer' | 'admin';
}

export interface PaymentRequest {
  orderId: string;
  amount: string;
  mode: PaymentMode;
}

export interface PaymentResult {
  paymentId: string;
  orderId: string;
  status: 'PAID' | 'FAILED';
  duplicate: boolean;
}

/** `accepted` = event-driven 202; `completed` = synchronous 201. */
export interface CheckoutResult {
  order: Order;
  outcome: 'completed' | 'accepted';
  replayed: boolean;
}

/**
 * Use-case APIs. The business router depends only on these, so the monolith
 * (in-process), REST gateway (HTTP clients) and event gateway expose an
 * identical HTTP contract from the same router code.
 */
export interface AuthApi {
  login(email: string, password: string): Promise<LoginResult>;
  userExists(userId: string): Promise<boolean>;
}

export interface CatalogApi {
  list(query: { category: string | null; page: number; pageSize: number }): Promise<Page<Product>>;
  search(query: { q: string; page: number; pageSize: number }): Promise<Page<Product>>;
  get(productId: string): Promise<Product>;
}

export interface InventoryApi {
  get(productId: string): Promise<InventoryView>;
}

export interface CartApi {
  get(userId: string): Promise<Cart>;
  upsert(userId: string, productId: string, quantity: number): Promise<Cart>;
  remove(userId: string, productId: string): Promise<Cart>;
}

export interface OrderApi {
  checkout(idempotencyKey: string, request: CheckoutRequest): Promise<CheckoutResult>;
  get(orderId: string): Promise<Order>;
  listByUser(userId: string, page: number, pageSize: number): Promise<Page<OrderSummary>>;
  cancel(orderId: string): Promise<Order>;
}

export interface PaymentApi {
  charge(request: PaymentRequest): Promise<PaymentResult>;
}

export interface SutApis {
  auth: AuthApi;
  catalog: CatalogApi;
  inventory: InventoryApi;
  cart: CartApi;
  orders: OrderApi;
  payments: PaymentApi;
}
