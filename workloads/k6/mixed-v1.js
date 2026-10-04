// k6 workload: MIXED_V1
// Browse 60%, cart 20%, checkout 15%, order read 5%
import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { recordResponse } from './error-metrics.js';
import { observeCheckout } from './checkout-observation.js';

const checkoutAcceptLatency = new Trend('checkout_accept_latency', true);
const checkoutSuccessRate = new Rate('checkout_acceptance_rate');
const stockoutRate = new Rate('stockout_rate');

const BASE_URL = __ENV.SUT_BASE_URL || 'http://localhost:3000';

export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    mixed: {
      executor: 'constant-arrival-rate',
      rate: parseInt(__ENV.TARGET_RPS || '25'),
      timeUnit: '1s',
      duration: __ENV.DURATION || '60s',
      preAllocatedVUs: parseInt(__ENV.PRE_ALLOCATED_VUS || '50'),
      maxVUs: parseInt(__ENV.MAX_VUS || '200'),
    },
  },
  thresholds: {
    http_req_duration: ['p(99)<500'],
    business_error_rate: ['rate<0.05'],
  },
  tags: {
    workload: 'MIXED_V1',
  },
};

const PRODUCT_IDS = JSON.parse(__ENV.PRODUCT_IDS || '[]');
const USER_IDS = JSON.parse(__ENV.USER_IDS || '[]');
const E2E_POLL_SAMPLE_RATE = parseFloat(__ENV.E2E_POLL_SAMPLE_RATE || '1');

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function headers() {
  return {
    'Content-Type': 'application/json',
    'X-Request-Id': `k6-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`,
  };
}

// Browse operations (60%)
function browseProducts() {
  const page = Math.floor(Math.random() * 5) + 1;
  const res = http.get(`${BASE_URL}/products?page=${page}&limit=20`, {
    headers: headers(),
    tags: { operation: 'product_list' },
  });
  check(res, { 'product list 200': (r) => r.status === 200 });
  recordResponse(res);
}

function viewProduct() {
  if (PRODUCT_IDS.length === 0) return browseProducts();
  const pid = pickRandom(PRODUCT_IDS);
  const res = http.get(`${BASE_URL}/products/${pid}`, {
    headers: headers(),
    tags: { operation: 'product_detail' },
  });
  check(res, { 'product detail 200': (r) => r.status === 200 });
  recordResponse(res);
}

function searchProducts() {
  const terms = ['laptop', 'phone', 'camera', 'headphones', 'tablet'];
  const q = pickRandom(terms);
  const res = http.get(`${BASE_URL}/products/search?q=${q}`, {
    headers: headers(),
    tags: { operation: 'search' },
  });
  check(res, { 'search 200': (r) => r.status === 200 });
  recordResponse(res);
}

// Cart operations (20%)
function addToCart() {
  if (PRODUCT_IDS.length === 0) return browseProducts();
  const pid = pickRandom(PRODUCT_IDS);
  const userId = pickRandom(USER_IDS);
  const res = http.post(`${BASE_URL}/cart/items`, JSON.stringify({
    productId: pid,
    quantity: Math.floor(Math.random() * 3) + 1,
  }), {
    headers: { ...headers(), 'X-User-Id': userId },
    tags: { operation: 'cart_write' },
  });
  check(res, { 'cart add ok': (r) => r.status < 500 });
  recordResponse(res);
}

// Checkout operations (15%)
function checkout() {
  if (PRODUCT_IDS.length === 0 || USER_IDS.length === 0) return browseProducts();
  const userId = pickRandom(USER_IDS);
  const productId = pickRandom(PRODUCT_IDS);
  const idempotencyKey = `k6-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

  const start = Date.now();
  const res = http.post(`${BASE_URL}/orders`, JSON.stringify({
    userId,
    items: [{ productId, quantity: 1 }],
    paymentMode: 'MOCK_SUCCESS',
  }), {
    headers: { ...headers(), 'Idempotency-Key': idempotencyKey },
    tags: { operation: 'checkout_accept' },
    responseType: 'text',
  });

  const acceptMs = Date.now() - start;
  checkoutAcceptLatency.add(acceptMs);

  check(res, { 'checkout accepted': (r) => r.status === 201 || r.status === 202 });
  recordResponse(res, [409, 422]);
  checkoutSuccessRate.add(res.status === 201 || res.status === 202);
  stockoutRate.add(res.status === 409);

  observeCheckout(res, BASE_URL, start, headers(), E2E_POLL_SAMPLE_RATE);
}

// Order read operations (5%)
function readOrders() {
  if (USER_IDS.length === 0) return browseProducts();
  const userId = pickRandom(USER_IDS);
  const res = http.get(`${BASE_URL}/users/${userId}/orders`, {
    headers: headers(),
    tags: { operation: 'order_read' },
  });
  check(res, { 'order read ok': (r) => r.status < 500 });
  recordResponse(res);
}

export default function () {
  const roll = Math.random();
  if (roll < 0.30) {
    browseProducts();
  } else if (roll < 0.48) {
    viewProduct();
  } else if (roll < 0.60) {
    searchProducts();
  } else if (roll < 0.80) {
    addToCart();
  } else if (roll < 0.95) {
    checkout();
  } else {
    readOrders();
  }
}
