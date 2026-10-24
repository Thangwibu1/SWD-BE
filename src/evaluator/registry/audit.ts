import { parse } from 'yaml';
import type { ArchitectureProfile } from './index.js';

/** Audit the rendered deployment, including concrete replicas and resource aliases. */
export function auditRenderedProfile(profile: ArchitectureProfile, content: string): string[] {
  const services = parse(content).services as Record<string, {
    environment?: Record<string, string>; cpus?: string; mem_limit?: string;
    depends_on?: Record<string, unknown>;
  }>;
  const errors: string[] = [];
  const used = new Set<string>();
  const counts = new Map<string, number>();
  for (const [name, service] of Object.entries(services)) {
    const role = service.environment?.APP_ROLE ?? name;
    counts.set(role, (counts.get(role) ?? 0) + 1);
    const key = profile.resources?.[name] ? name : name === 'app' ? role : name;
    const allocation = profile.resources?.[key];
    if (!allocation) errors.push(`${name}: missing resource allocation`);
    else {
      if (used.has(key)) errors.push(`${name}: reused resource allocation ${key}`);
      used.add(key);
      if (Math.abs(Number(service.cpus) - allocation.cpus) > 0.000001
        || service.mem_limit !== `${allocation.memoryMiB}m`) errors.push(`${name}: resource mismatch`);
    }
    if (service.environment?.APP_ROLE) {
      if (service.environment.ARCHITECTURE_ID !== profile.id) errors.push(`${name}: architecture ID mismatch`);
      if (!profile.allowedRoles.includes(name) && !profile.allowedRoles.includes(role)) errors.push(`${name}: undeclared role ${role}`);
    }
    for (const dependency of Object.keys(service.depends_on ?? {})) {
      if (!services[dependency]) errors.push(`${name}: missing dependency ${dependency}`);
    }
  }
  for (const key of Object.keys(profile.resources ?? {})) {
    if (!used.has(key)) errors.push(`${key}: allocated service is absent`);
  }
  for (const role of profile.allowedRoles) {
    if (!services[role] && !counts.has(role)) errors.push(`${role}: required role is absent`);
  }
  const expectCount = (role: string, count: number) => {
    if ((counts.get(role) ?? 0) !== count) errors.push(`${role}: expected ${count} instances, found ${counts.get(role) ?? 0}`);
  };
  expectCount('postgres', 1);
  expectCount('redis', profile.cache.enabled ? 1 : 0);
  expectCount('rabbitmq', profile.messaging.broker === 'RABBITMQ' ? 1 : 0);
  expectCount('api-gateway', profile.allowedRoles.includes('api-gateway') ? 1 : 0);
  if (profile.family === 'MODULAR_MONOLITH') {
    const dualApi = ['DUAL_APP_PROXY', 'DUAL_APP_PROXY_ASYNC', 'QUEUE_DUAL_API', 'QUEUE_DUAL_WORKER'].includes(profile.scalingProfile);
    expectCount('sut-monolith', dualApi ? 2 : 1);
    const dualWorker = ['QUEUE_DUAL_WORKER', 'QUEUE_SINGLE_API_DUAL_WORKER'].includes(profile.scalingProfile);
    expectCount('pg-queue-worker', profile.messaging.broker === 'POSTGRES' ? dualWorker ? 2 : 1 : 0);
  } else {
    for (const role of ['user-service', 'catalog-service', 'inventory-service', 'order-service', 'payment-mock', 'notification-mock']) {
      const scaled = (role === 'catalog-service' && profile.scalingProfile === 'CATALOG_SCALED')
        || (role === 'order-service' && profile.scalingProfile === 'ORDER_SCALED');
      expectCount(role, scaled ? 2 : 1);
    }
    expectCount('event-worker', profile.messaging.broker === 'RABBITMQ' ? profile.scalingProfile === 'ORDER_SCALED' ? 2 : 1 : 0);
  }
  return errors;
}

/** Concrete application processes, excluding the proxy and infrastructure. */
export function applicationInstanceCount(profile: ArchitectureProfile): number {
  return Object.keys(profile.resources ?? {}).filter(key => {
    if (['postgres', 'redis', 'rabbitmq', 'api-gateway'].includes(key)) return false;
    return key !== 'app' || !profile.allowedRoles.includes('api-gateway');
  }).length;
}
