import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execa } from 'execa';
import type { Logger } from '../../utils/logger.js';

export interface LoadRunnerConfig {
  workloadProfile: string;
  targetRps: number;
  durationSeconds: number;
  warmupSeconds: number;
  cooldownSeconds: number;
  sutBaseUrl: string;
  productIds: string[];
  userIds: string[];
  outputDir: string;
}

export interface LoadRunnerResult {
  summaryJsonPath: string;
  droppedIterations: number;
  totalRequests: number;
  httpReqDuration: {
    p50: number;
    p95: number;
    p99: number;
    avg: number;
    max: number;
  };
  httpReqFailed: number;
  achievedRps: number;
}

const WORKLOAD_MAP: Record<string, string> = {
  BROWSING_V1: 'browsing-v1.js',
  MIXED_V1: 'mixed-v1.js',
  CHECKOUT_V1: 'checkout-v1.js',
  FLASH_SALE_V1: 'flash-sale-v1.js',
};

export async function runK6Load(
  config: LoadRunnerConfig,
  logger: Logger,
): Promise<LoadRunnerResult> {
  const workloadFile = WORKLOAD_MAP[config.workloadProfile];
  if (!workloadFile) {
    throw new Error(`Unknown workload profile: ${config.workloadProfile}`);
  }

  const scriptPath = path.resolve('workloads/k6', workloadFile);
  if (!existsSync(scriptPath)) {
    throw new Error(`k6 script not found: ${scriptPath}`);
  }

  if (!existsSync(config.outputDir)) {
    mkdirSync(config.outputDir, { recursive: true });
  }

  const summaryPath = path.join(config.outputDir, 'k6-summary.json');
  const timeseriesPath = path.join(config.outputDir, 'k6-timeseries.json');

  const k6Bin = process.env['K6_BIN'] || 'k6';

  logger.info({
    workload: config.workloadProfile,
    targetRps: config.targetRps,
    duration: config.durationSeconds,
    sutBaseUrl: config.sutBaseUrl,
  }, 'Starting k6 load test');

  const env: Record<string, string> = {
    SUT_BASE_URL: config.sutBaseUrl,
    TARGET_RPS: String(config.targetRps),
    DURATION: `${config.durationSeconds}s`,
    PRE_ALLOCATED_VUS: String(Math.max(50, config.targetRps * 2)),
    MAX_VUS: String(Math.max(200, config.targetRps * 5)),
    PRODUCT_IDS: JSON.stringify(config.productIds),
    USER_IDS: JSON.stringify(config.userIds),
  };

  const args = [
    'run',
    '--summary-export', summaryPath,
    '--out', `json=${timeseriesPath}`,
    '--no-color',
    scriptPath,
  ];

  try {
    const result = await execa(k6Bin, args, {
      env,
      timeout: (config.warmupSeconds + config.durationSeconds + config.cooldownSeconds + 120) * 1000,
      reject: false,
    });

    if (result.exitCode !== 0) {
      logger.warn({ exitCode: result.exitCode, stderr: result.stderr.slice(0, 2000) }, 'k6 exited with non-zero code');
    }

    // Parse summary
    if (existsSync(summaryPath)) {
      const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
      const metrics = summary.metrics || {};

      const httpDuration = metrics['http_req_duration'] || {};
      const httpFailed = metrics['http_req_failed'] || {};
      const iterations = metrics['iterations'] || {};
      const droppedIter = metrics['dropped_iterations'] || {};

      const p50 = httpDuration.values?.['p(50)'] ?? 0;
      const p95 = httpDuration.values?.['p(95)'] ?? 0;
      const p99 = httpDuration.values?.['p(99)'] ?? 0;
      const avg = httpDuration.values?.avg ?? 0;
      const max = httpDuration.values?.max ?? 0;

      const totalRequests = iterations.values?.count ?? 0;
      const achievedRps = iterations.values?.rate ?? 0;
      const droppedCount = droppedIter.values?.count ?? 0;
      const failRate = httpFailed.values?.rate ?? 0;

      logger.info({
        p50: p50.toFixed(2),
        p95: p95.toFixed(2),
        p99: p99.toFixed(2),
        totalRequests,
        achievedRps: achievedRps.toFixed(2),
        droppedIterations: droppedCount,
        failRate: failRate.toFixed(4),
      }, 'k6 load test completed');

      return {
        summaryJsonPath: summaryPath,
        droppedIterations: droppedCount,
        totalRequests,
        httpReqDuration: { p50, p95, p99, avg, max },
        httpReqFailed: failRate,
        achievedRps,
      };
    }

    // Fallback if no summary file
    return {
      summaryJsonPath: summaryPath,
      droppedIterations: 0,
      totalRequests: 0,
      httpReqDuration: { p50: 0, p95: 0, p99: 0, avg: 0, max: 0 },
      httpReqFailed: 1,
      achievedRps: 0,
    };
  } catch (err: unknown) {
    logger.error({ err }, 'k6 execution failed');
    throw err;
  }
}
