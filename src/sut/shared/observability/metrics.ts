import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export interface SutMetrics {
  registry: Registry;
  service: string;
  httpRequests: Counter<'service' | 'route' | 'method' | 'status'>;
  httpDuration: Histogram<'service' | 'route' | 'method'>;
  dbQueryDuration: Histogram<'operation'>;
  dbPoolActive: Gauge;
  dbPoolWaiting: Gauge;
  cacheRequests: Counter<'result'>;
  cacheDuration: Histogram;
  eventsPublished: Counter<'event_type'>;
  eventsConsumed: Counter<'event_type'>;
  eventProcessingDuration: Histogram<'event_type'>;
  eventRedeliveries: Counter<'event_type'>;
  invariantViolations: Counter<'invariant'>;
}

let singleton: SutMetrics | undefined;
const latencyBuckets = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.25, 0.5, 1, 2.5, 5];

export function getSutMetrics(): SutMetrics {
  if (singleton) return singleton;
  const registry = new Registry();
  const service = process.env['APP_ROLE'] ?? 'sut';
  collectDefaultMetrics({ register: registry, prefix: 'sut_' });
  singleton = {
    registry,
    service,
    httpRequests: new Counter({ name: 'http_server_requests_total', help: 'SUT HTTP requests',
      labelNames: ['service', 'route', 'method', 'status'], registers: [registry] }),
    httpDuration: new Histogram({ name: 'http_server_request_duration_seconds', help: 'SUT HTTP request latency',
      labelNames: ['service', 'route', 'method'], buckets: latencyBuckets, registers: [registry] }),
    dbQueryDuration: new Histogram({ name: 'db_query_duration_seconds', help: 'Database query latency',
      labelNames: ['operation'], buckets: latencyBuckets, registers: [registry] }),
    dbPoolActive: new Gauge({ name: 'db_pool_active', help: 'Active PostgreSQL pool connections', registers: [registry] }),
    dbPoolWaiting: new Gauge({ name: 'db_pool_waiting', help: 'Waiting PostgreSQL pool requests', registers: [registry] }),
    cacheRequests: new Counter({ name: 'cache_requests_total', help: 'Cache lookups', labelNames: ['result'], registers: [registry] }),
    cacheDuration: new Histogram({ name: 'cache_operation_duration_seconds', help: 'Cache operation latency',
      buckets: latencyBuckets, registers: [registry] }),
    eventsPublished: new Counter({ name: 'events_published_total', help: 'Published domain events',
      labelNames: ['event_type'], registers: [registry] }),
    eventsConsumed: new Counter({ name: 'events_consumed_total', help: 'Consumed domain events',
      labelNames: ['event_type'], registers: [registry] }),
    eventProcessingDuration: new Histogram({ name: 'event_processing_duration_seconds', help: 'Event handler latency',
      labelNames: ['event_type'], buckets: latencyBuckets, registers: [registry] }),
    eventRedeliveries: new Counter({ name: 'event_redeliveries_total', help: 'Redelivered domain events',
      labelNames: ['event_type'], registers: [registry] }),
    invariantViolations: new Counter({ name: 'business_invariant_violations_total', help: 'Detected business invariant violations',
      labelNames: ['invariant'], registers: [registry] }),
  };
  singleton.cacheRequests.inc({ result: 'hit' }, 0);
  singleton.cacheRequests.inc({ result: 'miss' }, 0);
  for (let index = 1; index <= 7; index += 1) singleton.invariantViolations.inc({ invariant: `INV-${String(index).padStart(2, '0')}` }, 0);
  return singleton;
}
