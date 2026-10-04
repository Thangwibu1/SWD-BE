import { Rate, Trend } from 'k6/metrics';

export const businessErrors = new Rate('business_error_rate');
const http5xx = new Rate('http_5xx_rate');
const unexpected4xx = new Rate('http_4xx_unexpected_rate');
const networkErrors = new Rate('network_error_rate');
const timeouts = new Rate('timeout_rate');
const operationLatency = new Trend('operation_latency', true);

export function recordResponse(response, businessStatuses = []) {
  // Only primary operations call this helper; background status polling does not.
  operationLatency.add(response.timings.duration);
  const status = Number(response.status || 0);
  const message = String(response.error || '').toLowerCase();
  const timeout = response.error_code === 1050 || message.includes('timeout');
  const network = status === 0 && !timeout;
  const business = businessStatuses.includes(status);
  http5xx.add(status >= 500);
  unexpected4xx.add(status >= 400 && status < 500 && !business);
  networkErrors.add(network);
  timeouts.add(timeout);
  businessErrors.add(business);
}
