// k6 workload: FLASH_SALE_V1
// Checkout 80% on 20 hot SKUs, order read 20%
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
    flash_sale: {
      executor: 'constant-arrival-rate',
      rate: parseInt(__ENV.TARGET_RPS || '25'),
      timeUnit: '1s',
      duration: __ENV.DURATION || '60s',
      preAllocatedVUs: parseInt(__ENV.PRE_ALLOCATED_VUS || '100'),
      maxVUs: parseInt(__ENV.MAX_VUS || '400'),
    },
  },
  tags: { workload: 'FLASH_SALE_V1' },
};

// Hot SKUs are the first 20 products (Zipf-popular)
const PRODUCT_IDS = JSON.parse(__ENV.PRODUCT_IDS || '[]');
const HOT_SKUS = PRODUCT_IDS.slice(0, 20);
const USER_IDS = JSON.parse(__ENV.USER_IDS || '[]');
const E2E_POLL_SAMPLE_RATE = parseFloat(__ENV.E2E_POLL_SAMPLE_RATE || '0.01');

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function headers() {
  return { 'Content-Type': 'application/json', 'X-Request-Id': `k6-${Date.now()}-${Math.random().toString(36).substring(2, 10)}` };
}

function flashCheckout() {
  if (!HOT_SKUS.length || !USER_IDS.length) return;
  const idempotencyKey = `k6-flash-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
  const start = Date.now();
  const res = http.post(`${BASE_URL}/orders`, JSON.stringify({
    userId: pickRandom(USER_IDS),
    items: [{ productId: pickRandom(HOT_SKUS), quantity: 1 }],
    paymentMode: 'MOCK_SUCCESS',
  }), { headers: { ...headers(), 'Idempotency-Key': idempotencyKey }, tags: { operation: 'checkout_accept' }, responseType: 'text' });
  checkoutAcceptLatency.add(Date.now() - start);
  check(res, { 'checkout ok': (r) => r.status === 201 || r.status === 202 || r.status === 409 });
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
  if (Math.random() < 0.80) flashCheckout();
  else readOrders();
}
