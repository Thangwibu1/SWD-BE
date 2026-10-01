/**
 * The 15 SUT endpoints (guide section 8). Every architecture family must
 * serve exactly these routes; contract tests diff each app against this list.
 * `path` uses Express syntax; `openapiPath` uses OpenAPI syntax.
 */
export const SUT_ROUTES = [
  { id: 1, method: 'post', path: '/auth/login', openapiPath: '/auth/login', operationId: 'login' },
  {
    id: 2,
    method: 'get',
    path: '/products',
    openapiPath: '/products',
    operationId: 'listProducts',
  },
  {
    id: 3,
    method: 'get',
    path: '/products/:id',
    openapiPath: '/products/{id}',
    operationId: 'getProduct',
  },
  {
    id: 4,
    method: 'get',
    path: '/products/search',
    openapiPath: '/products/search',
    operationId: 'searchProducts',
  },
  {
    id: 5,
    method: 'get',
    path: '/inventory/:productId',
    openapiPath: '/inventory/{productId}',
    operationId: 'getInventory',
  },
  {
    id: 6,
    method: 'post',
    path: '/cart/items',
    openapiPath: '/cart/items',
    operationId: 'upsertCartItem',
  },
  { id: 7, method: 'get', path: '/cart', openapiPath: '/cart', operationId: 'getCart' },
  {
    id: 8,
    method: 'delete',
    path: '/cart/items/:productId',
    openapiPath: '/cart/items/{productId}',
    operationId: 'removeCartItem',
  },
  { id: 9, method: 'post', path: '/orders', openapiPath: '/orders', operationId: 'checkout' },
  {
    id: 10,
    method: 'get',
    path: '/orders/:id',
    openapiPath: '/orders/{id}',
    operationId: 'getOrder',
  },
  {
    id: 11,
    method: 'get',
    path: '/users/:id/orders',
    openapiPath: '/users/{id}/orders',
    operationId: 'listUserOrders',
  },
  {
    id: 12,
    method: 'post',
    path: '/payments/mock',
    openapiPath: '/payments/mock',
    operationId: 'mockPayment',
  },
  {
    id: 13,
    method: 'post',
    path: '/orders/:id/cancel',
    openapiPath: '/orders/{id}/cancel',
    operationId: 'cancelOrder',
  },
  { id: 14, method: 'get', path: '/health', openapiPath: '/health', operationId: 'health' },
  { id: 15, method: 'get', path: '/ready', openapiPath: '/ready', operationId: 'ready' },
] as const;

export type SutRoute = (typeof SUT_ROUTES)[number];

export const PAYMENT_MODES = ['MOCK_SUCCESS', 'MOCK_FAIL', 'MOCK_TIMEOUT'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];
