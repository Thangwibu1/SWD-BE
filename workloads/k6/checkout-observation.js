import http from 'k6/http';
import { sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

const confirmed = new Rate('checkout_sampled_confirmation_rate');
const timedOut = new Rate('checkout_sampled_unsettled_rate');
const samples = new Counter('checkout_confirmation_samples');
const latency = new Trend('checkout_confirmed_e2e_latency', true);

// Sampling is independent of the acceptance result. Unobserved orders are
// never reported as confirmed, and timeouts remain in the sample denominator.
export function observeCheckout(response, baseUrl, startedAt, headers, sampleRate) {
  if (Math.random() >= sampleRate) return;
  samples.add(1);
  let status = response.status === 201 ? 'CONFIRMED' : 'REJECTED';
  if (response.status === 202) {
    status = 'UNSETTLED';
    try {
      const body = JSON.parse(response.body);
      const id = body.orderId || body.id;
      if (id) for (let attempt = 0; attempt < 10; attempt++) {
        sleep(0.5);
        const poll = http.get(`${baseUrl}/orders/${id}`, {
          headers, tags: { operation: 'checkout_status_poll' }, responseType: 'text', timeout: '2s',
        });
        if (poll.status !== 200) continue;
        const order = JSON.parse(poll.body);
        if (order.status === 'CONFIRMED' || order.status === 'FAILED') {
          status = order.status;
          break;
        }
      }
    } catch { /* malformed or unavailable status remains unsettled */ }
  }
  confirmed.add(status === 'CONFIRMED');
  timedOut.add(status === 'UNSETTLED');
  if (status === 'CONFIRMED') latency.add(Date.now() - startedAt);
}
