import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from '../../utils/logger.js';

export interface CostCatalog {
  version: string;
  currency: string;
  hoursPerMonth: number;
  rates: {
    vcpuHour: number;
    gbRamHour: number;
    gbStorageMonth: number;
    gbEgress: number;
    postgresFixedMonth: number;
    redisFixedMonth: number;
    rabbitmqFixedMonth: number;
    loadBalancerMonth: number;
  };
  engineering: {
    hourlyRate: number;
    complexityHours: { LOW: number; MEDIUM: number; HIGH: number };
  };
}

export interface ResourceAllocation {
  totalVCPU: number;
  totalMemoryGiB: number;
  hasRedis: boolean;
  hasRabbitMQ: boolean;
  hasLoadBalancer: boolean;
  replicaCount: number;
  storageGiB: number;
  egressGiBPerMonth: number;
}

export interface CostResult {
  catalogVersion: string;
  currency: string;
  computeMonth: number;
  managedServicesMonth: number;
  trafficMonth: number;
  infraMonth: number;
  initialEngineering: number;
  maintenanceMonth: number;
  tco12m: number;
  engineeringComplexity: 'LOW' | 'MEDIUM' | 'HIGH';
  breakdown: Record<string, number>;
}

/**
 * Load a cost catalog from the cost-catalogs directory.
 */
export function loadCostCatalog(version: string): CostCatalog {
  const catalogPath = path.resolve('cost-catalogs', `${version}.json`);
  const data = readFileSync(catalogPath, 'utf8');
  return JSON.parse(data) as CostCatalog;
}

/**
 * Determine engineering complexity based on architecture characteristics.
 */
export function determineComplexity(
  architectureFamily: string,
  hasCache: boolean,
  hasMessaging: boolean,
  replicaCount: number,
): 'LOW' | 'MEDIUM' | 'HIGH' {
  let score = 0;

  if (architectureFamily === 'MODULAR_MONOLITH') score += 1;
  else if (architectureFamily === 'REST_MICROSERVICES') score += 3;
  else if (architectureFamily === 'EVENT_DRIVEN_MICROSERVICES') score += 5;

  if (hasCache) score += 1;
  if (hasMessaging) score += 2;
  if (replicaCount > 3) score += 1;

  if (score <= 3) return 'LOW';
  if (score <= 6) return 'MEDIUM';
  return 'HIGH';
}

/**
 * Round to 2 decimal places for currency.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Compute cost using the guide's formulas from section 21.
 */
export function computeCost(
  catalog: CostCatalog,
  allocation: ResourceAllocation,
  architectureFamily: string,
  hasCache: boolean,
  hasMessaging: boolean,
  logger: Logger,
): CostResult {
  // ComputeMonth = 730 * (AllocatedVCPU * RateVCPU + AllocatedGB * RateRAM)
  const computeMonth = catalog.hoursPerMonth * (
    allocation.totalVCPU * catalog.rates.vcpuHour +
    allocation.totalMemoryGiB * catalog.rates.gbRamHour
  );

  // ManagedServices = PostgreSQL + optional Redis + optional RabbitMQ + optional LB
  let managedServicesMonth = catalog.rates.postgresFixedMonth;
  if (allocation.hasRedis) managedServicesMonth += catalog.rates.redisFixedMonth;
  if (allocation.hasRabbitMQ) managedServicesMonth += catalog.rates.rabbitmqFixedMonth;
  if (allocation.hasLoadBalancer) managedServicesMonth += catalog.rates.loadBalancerMonth;

  // TrafficCost = MonthlyEgressGB * RateEgress
  const trafficMonth = allocation.egressGiBPerMonth * catalog.rates.gbEgress;

  const infraMonth = computeMonth + managedServicesMonth + trafficMonth;

  // Engineering
  const complexity = determineComplexity(architectureFamily, hasCache, hasMessaging, allocation.replicaCount);
  const initialEngineering = catalog.engineering.complexityHours[complexity] * catalog.engineering.hourlyRate;
  const maintenanceMonth = initialEngineering * 0.1; // 10% of initial per month

  // TCO12m = 12 * InfraMonth + InitialEngineering + 12 * MaintenanceMonth
  const tco12m = 12 * infraMonth + initialEngineering + 12 * maintenanceMonth;

  const result: CostResult = {
    catalogVersion: catalog.version,
    currency: catalog.currency,
    computeMonth: Math.round(computeMonth * 100) / 100,
    managedServicesMonth,
    trafficMonth: Math.round(trafficMonth * 100) / 100,
    infraMonth: Math.round(infraMonth * 100) / 100,
    initialEngineering,
    maintenanceMonth: Math.round(maintenanceMonth * 100) / 100,
    tco12m: Math.round(tco12m * 100) / 100,
    engineeringComplexity: complexity,
    breakdown: {
      compute: Math.round(computeMonth * 100) / 100,
      postgres: catalog.rates.postgresFixedMonth,
      redis: allocation.hasRedis ? catalog.rates.redisFixedMonth : 0,
      rabbitmq: allocation.hasRabbitMQ ? catalog.rates.rabbitmqFixedMonth : 0,
      loadBalancer: allocation.hasLoadBalancer ? catalog.rates.loadBalancerMonth : 0,
      traffic: Math.round(trafficMonth * 100) / 100,
    },
  };

  logger.info({
    infraMonth: result.infraMonth,
    tco12m: result.tco12m,
    complexity,
  }, 'Cost computation complete');

  return result;
}
