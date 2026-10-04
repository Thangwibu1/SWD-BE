// k6 workload: CHECKOUT_V1
// Cart 20%, checkout 60%, order read 20%
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
const E2E_POLL_SAMPLE_RATE = parseFloat(__ENV.E2E_POLL_SAMPLE_RATE || '1');

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function headers() {
  return { 'Content-Type': 'application/json', 'X-Request-Id': `k6-${Date.now()}-${Math.random().toString(36).substring(2, 10)}` };
}

function addToCart() {
  if (!PRODUCT_IDS.length) return;
  const userId = pickRandom(USER_IDS);
  const res = http.post(`${BASE_URL}/cart/items`, JSON.stringify({
    productId: pickRandom(PRODUCT_IDS), quantity: Math.floor(Math.random() * 3) + 1,
  }), { headers: { ...headers(), 'X-User-Id': userId }, tags: { operation: 'cart_write' } });
  check(res, { 'cart ok': (r) => r.status < 500 });
  recordResponse(res);
}

function doCheckout() {
  if (!PRODUCT_IDS.length || !USER_IDS.length) return;
  const idempotencyKey = `k6-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
  const start = Date.now();
  const res = http.post(`${BASE_URL}/orders`, JSON.stringify({
    userId: pickRandom(USER_IDS),
    items: [{ productId: pickRandom(PRODUCT_IDS), quantity: 1 }],
    paymentMode: 'MOCK_SUCCESS',
  }), { headers: { ...headers(), 'Idempotency-Key': idempotencyKey }, tags: { operation: 'checkout_accept' }, responseType: 'text' });
  const acceptMs = Date.now() - start;
  checkoutAcceptLatency.add(acceptMs);
  check(res, { 'checkout ok': (r) => r.status === 201 || r.status === 202 });
  recordResponse(res, [409, 422]);
  checkoutSuccessRate.add(res.status === 201 || res.status === 202);
  stockoutRate.add(res.status === 409);

  observeCheckout(res, BASE_URL, start, headers(), E2E_POLL_SAMPLE_RATE);
}

function readOrders() {
  if (!USER_IDS.length) return;
  const res = http.get(`${BASE_URL}/users/${pickRandom(USER_IDS)}/orders`, { headers: headers(), tags: { operation: 'order_read' } });
  check(res, { 'order read ok': (r) => r.status < 500 });
  recordResponse(res);
}

export default function () {
  const roll = Math.random();
  if (roll < 0.20) addToCart();
  else if (roll < 0.80) doCheckout();
  else readOrders();
}
