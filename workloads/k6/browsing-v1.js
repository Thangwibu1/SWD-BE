// k6 workload: BROWSING_V1
// List 45%, detail 30%, search 15%, inventory 10%
import http from 'k6/http';
import { check } from 'k6';
import { recordResponse } from './error-metrics.js';
const BASE_URL = __ENV.SUT_BASE_URL || 'http://localhost:3000';

export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    browsing: {
      executor: 'constant-arrival-rate',
      rate: parseInt(__ENV.TARGET_RPS || '25'),
      timeUnit: '1s',
      duration: __ENV.DURATION || '60s',
      preAllocatedVUs: parseInt(__ENV.PRE_ALLOCATED_VUS || '50'),
      maxVUs: parseInt(__ENV.MAX_VUS || '200'),
    },
  },
  tags: { workload: 'BROWSING_V1' },
};

const PRODUCT_IDS = JSON.parse(__ENV.PRODUCT_IDS || '[]');

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function headers() {
  return { 'Content-Type': 'application/json', 'X-Request-Id': `k6-${Date.now()}-${Math.random().toString(36).substring(2, 10)}` };
}

function listProducts() {
  const page = Math.floor(Math.random() * 5) + 1;
  const res = http.get(`${BASE_URL}/products?page=${page}&limit=20`, { headers: headers(), tags: { operation: 'product_list' } });
  check(res, { 'list 200': (r) => r.status === 200 });
  recordResponse(res);
}

function viewProduct() {
  if (!PRODUCT_IDS.length) return listProducts();
  const res = http.get(`${BASE_URL}/products/${pickRandom(PRODUCT_IDS)}`, { headers: headers(), tags: { operation: 'product_detail' } });
  check(res, { 'detail 200': (r) => r.status === 200 });
  recordResponse(res);
}

function searchProducts() {
  const terms = ['laptop', 'phone', 'camera', 'headphones', 'tablet'];
  const res = http.get(`${BASE_URL}/products/search?q=${pickRandom(terms)}`, { headers: headers(), tags: { operation: 'search' } });
  check(res, { 'search 200': (r) => r.status === 200 });
  recordResponse(res);
}

function checkInventory() {
  if (!PRODUCT_IDS.length) return listProducts();
  const res = http.get(`${BASE_URL}/inventory/${pickRandom(PRODUCT_IDS)}`, { headers: headers(), tags: { operation: 'inventory_check' } });
  check(res, { 'inv 200': (r) => r.status === 200 });
  recordResponse(res);
}

export default function () {
  const roll = Math.random();
  if (roll < 0.45) listProducts();
  else if (roll < 0.75) viewProduct();
  else if (roll < 0.90) searchProducts();
  else checkInventory();
}
