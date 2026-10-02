// k6 workload: CHECKOUT_V1
// Cart 20%, checkout 60%, order read 20%
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('business_errors');
const checkoutAcceptLatency = new Trend('checkout_accept_latency', true);
const checkoutE2eLatency = new Trend('checkout_e2e_latency', true);
const BASE_URL = __ENV.SUT_BASE_URL || 'http://localhost:3000';

export const options = {
  scenarios: {
    checkout: {
      executor: 'constant-arrival-rate',
      rate: parseInt(__ENV.TARGET_RPS || '25'),
      timeUnit: '1s',
      duration: __ENV.DURATION || '60s',
      preAllocatedVUs: parseInt(__ENV.PRE_ALLOCATED_VUS || '50'),
      maxVUs: parseInt(__ENV.MAX_VUS || '200'),
    },
  },
  tags: { workload: 'CHECKOUT_V1' },
};

const PRODUCT_IDS = JSON.parse(__ENV.PRODUCT_IDS || '[]');
const USER_IDS = JSON.parse(__ENV.USER_IDS || '[]');

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function headers() {
  return { 'Content-Type': 'application/json', 'X-Request-Id': `k6-${Date.now()}-${Math.random().toString(36).substring(2, 10)}` };
}

function addToCart() {
  if (!PRODUCT_IDS.length) return;
  const res = http.post(`${BASE_URL}/cart/items`, JSON.stringify({
    productId: pickRandom(PRODUCT_IDS), quantity: Math.floor(Math.random() * 3) + 1,
  }), { headers: headers(), tags: { operation: 'cart_write' } });
  check(res, { 'cart ok': (r) => r.status < 500 });
  if (res.status >= 500) errorRate.add(1); else errorRate.add(0);
}

function doCheckout() {
  if (!PRODUCT_IDS.length || !USER_IDS.length) return;
  const idempotencyKey = `k6-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
  const start = Date.now();
  const res = http.post(`${BASE_URL}/orders`, JSON.stringify({
    userId: pickRandom(USER_IDS),
    items: [{ productId: pickRandom(PRODUCT_IDS), quantity: 1 }],
    paymentMode: 'MOCK_SUCCESS',
  }), { headers: { ...headers(), 'Idempotency-Key': idempotencyKey }, tags: { operation: 'checkout_accept' } });
  const acceptMs = Date.now() - start;
  checkoutAcceptLatency.add(acceptMs);
  check(res, { 'checkout ok': (r) => r.status === 201 || r.status === 202 });
  if (res.status >= 500) errorRate.add(1); else errorRate.add(0);

  if (res.status === 202) {
    try {
      const body = JSON.parse(res.body);
      const orderId = body.orderId || body.id;
      if (orderId) {
        for (let i = 0; i < 10; i++) {
          sleep(0.5);
          const poll = http.get(`${BASE_URL}/orders/${orderId}`, { headers: headers(), tags: { operation: 'checkout_e2e' } });
          if (poll.status === 200) {
            try {
              const order = JSON.parse(poll.body);
              if (order.status === 'CONFIRMED' || order.status === 'FAILED') {
                checkoutE2eLatency.add(Date.now() - start);
                break;
              }
            } catch (_) {}
          }
        }
      }
    } catch (_) {}
  } else { checkoutE2eLatency.add(acceptMs); }
}

function readOrders() {
  if (!USER_IDS.length) return;
  const res = http.get(`${BASE_URL}/users/${pickRandom(USER_IDS)}/orders`, { headers: headers(), tags: { operation: 'order_read' } });
  check(res, { 'order read ok': (r) => r.status < 500 });
  if (res.status >= 500) errorRate.add(1); else errorRate.add(0);
}

export default function () {
  const roll = Math.random();
  if (roll < 0.20) addToCart();
  else if (roll < 0.80) doCheckout();
  else readOrders();
}
