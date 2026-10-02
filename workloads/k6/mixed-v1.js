// k6 workload: MIXED_V1
// Browse 60%, cart 20%, checkout 15%, order read 5%
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('business_errors');
const checkoutAcceptLatency = new Trend('checkout_accept_latency', true);
const checkoutE2eLatency = new Trend('checkout_e2e_latency', true);

const BASE_URL = __ENV.SUT_BASE_URL || 'http://localhost:3000';

export const options = {
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
    business_errors: ['rate<0.05'],
  },
  tags: {
    workload: 'MIXED_V1',
  },
};

const PRODUCT_IDS = JSON.parse(__ENV.PRODUCT_IDS || '[]');
const USER_IDS = JSON.parse(__ENV.USER_IDS || '[]');

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
  if (res.status >= 500) errorRate.add(1); else errorRate.add(0);
}

function viewProduct() {
  if (PRODUCT_IDS.length === 0) return browseProducts();
  const pid = pickRandom(PRODUCT_IDS);
  const res = http.get(`${BASE_URL}/products/${pid}`, {
    headers: headers(),
    tags: { operation: 'product_detail' },
  });
  check(res, { 'product detail 200': (r) => r.status === 200 });
  if (res.status >= 500) errorRate.add(1); else errorRate.add(0);
}

function searchProducts() {
  const terms = ['laptop', 'phone', 'camera', 'headphones', 'tablet'];
  const q = pickRandom(terms);
  const res = http.get(`${BASE_URL}/products/search?q=${q}`, {
    headers: headers(),
    tags: { operation: 'search' },
  });
  check(res, { 'search 200': (r) => r.status === 200 });
  if (res.status >= 500) errorRate.add(1); else errorRate.add(0);
}

// Cart operations (20%)
function addToCart() {
  if (PRODUCT_IDS.length === 0) return browseProducts();
  const pid = pickRandom(PRODUCT_IDS);
  const res = http.post(`${BASE_URL}/cart/items`, JSON.stringify({
    productId: pid,
    quantity: Math.floor(Math.random() * 3) + 1,
  }), {
    headers: headers(),
    tags: { operation: 'cart_write' },
  });
  check(res, { 'cart add ok': (r) => r.status < 500 });
  if (res.status >= 500) errorRate.add(1); else errorRate.add(0);
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
  });

  const acceptMs = Date.now() - start;
  checkoutAcceptLatency.add(acceptMs);

  check(res, { 'checkout accepted': (r) => r.status === 201 || r.status === 202 });
  if (res.status >= 500) errorRate.add(1); else errorRate.add(0);

  // For event-driven: poll order status for e2e latency
  if (res.status === 202) {
    try {
      const body = JSON.parse(res.body);
      const orderId = body.orderId || body.id;
      if (orderId) {
        let settled = false;
        for (let i = 0; i < 10 && !settled; i++) {
          sleep(0.5);
          const poll = http.get(`${BASE_URL}/orders/${orderId}`, {
            headers: headers(),
            tags: { operation: 'checkout_e2e' },
          });
          if (poll.status === 200) {
            try {
              const order = JSON.parse(poll.body);
              if (order.status === 'CONFIRMED' || order.status === 'FAILED') {
                settled = true;
                checkoutE2eLatency.add(Date.now() - start);
              }
            } catch (_) { /* ignore parse errors */ }
          }
        }
      }
    } catch (_) { /* ignore */ }
  } else {
    checkoutE2eLatency.add(acceptMs);
  }
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
  if (res.status >= 500) errorRate.add(1); else errorRate.add(0);
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
