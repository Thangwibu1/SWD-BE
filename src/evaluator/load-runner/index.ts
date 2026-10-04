import path from 'node:path';
import os from 'node:os';
import { readFileSync, mkdirSync, existsSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { execa, type Options } from 'execa';
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
  signal?: AbortSignal;
}

export interface LoadRunnerResult {
  measurementSchemaVersion: string;
  summaryJsonPath: string;
  droppedIterations: number;
  totalIterations: number;
  totalRequests: number;
  httpReqDuration: {
    p50: number;
    p95: number;
    p99: number;
    avg: number;
    max: number;
  };
  httpReqFailed: number;
  errorBreakdown: {
    http5xxRate: number;
    http4xxUnexpectedRate: number;
    networkErrorRate: number;
    timeoutRate: number;
    businessErrorRate: number;
  };
  /** Completed benchmark operations per second (k6 iterations). */
  achievedRps: number;
  /** Actual HTTP requests per second, including sampled event-status polling. */
  achievedHttpRps: number;
  checkoutAcceptanceRate: number;
  checkoutConfirmationSamples: number;
  checkoutSampledConfirmationRate: number | null;
  checkoutSampledUnsettledRate: number | null;
  stockoutRate: number;
  measurementDurationSeconds: number;
  exitCode: number;
  loadHostCpuPercent: number;
}

const WORKLOAD_MAP: Record<string, string> = {
  BROWSING_V1: 'browsing-v1.js',
  MIXED_V1: 'mixed-v1.js',
  CHECKOUT_V1: 'checkout-v1.js',
  FLASH_SALE_V1: 'flash-sale-v1.js',
};

export interface K6Runner {
  run(config: LoadRunnerConfig, logger: Logger): Promise<LoadRunnerResult>;
}

export class LocalK6Runner implements K6Runner {
  run(config: LoadRunnerConfig, logger: Logger): Promise<LoadRunnerResult> {
    return runLocalK6Load(config, logger);
  }
}

export class SshK6Runner implements K6Runner {
  async run(config: LoadRunnerConfig, logger: Logger): Promise<LoadRunnerResult> {
    const host = process.env['LOAD_HOST_SSH'] ?? '';
    const workdir = process.env['LOAD_HOST_WORKDIR'] ?? '/opt/architecture-benchmark';
    if (!/^[A-Za-z0-9_.-]+(?:@[A-Za-z0-9_.-]+)?$/.test(host)) throw new Error('LOAD_HOST_SSH is missing or unsafe');
    if (!/^\/[A-Za-z0-9_./-]+$/.test(workdir)) throw new Error('LOAD_HOST_WORKDIR is unsafe');
    const workloadFile = WORKLOAD_MAP[config.workloadProfile];
    if (!workloadFile) throw new Error(`Unknown workload profile: ${config.workloadProfile}`);
    mkdirSync(config.outputDir, { recursive: true });
    const remoteDir = `${workdir}/run-${Date.now()}-${process.pid}`;
    const localScript = path.resolve('workloads/k6', workloadFile);
    const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
    const ssh = sshArguments(host);
    const scp = scpArguments();
    await execa('ssh', [...ssh, host, `mkdir -p ${quote(remoteDir)}`]);
    await execa('scp', [...scp, localScript, `${host}:${remoteDir}/${workloadFile}`]);
    await execa('scp', [...scp, path.resolve('workloads/k6/error-metrics.js'), `${host}:${remoteDir}/error-metrics.js`]);
    await execa('scp', [...scp, path.resolve('workloads/k6/checkout-observation.js'), `${host}:${remoteDir}/checkout-observation.js`]);
    const vus = vuAllocation(config);
    const includeTimeseries = shouldWriteTimeseries(config.targetRps);
    const env = {
      SUT_BASE_URL: remoteSutBaseUrl(config.sutBaseUrl), TARGET_RPS: String(config.targetRps), DURATION: `${config.durationSeconds}s`,
      PRE_ALLOCATED_VUS: String(vus.preAllocated), MAX_VUS: String(vus.max),
      E2E_POLL_SAMPLE_RATE: String(e2ePollSampleRate(config.targetRps)),
      PRODUCT_IDS: JSON.stringify(config.productIds), USER_IDS: JSON.stringify(config.userIds),
    };
    const assignments = Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`).join(' ');
    writeLoadConfiguration(config, env, includeTimeseries, 'ssh');
    const artifactLimitBlocks = Math.ceil(maxArtifactFileBytes() / 512);
    const cpuBefore = await remoteCpuSnapshot(host);
    const summaryPath = path.join(config.outputDir, 'k6-summary.json');
    const timeseriesPath = path.join(config.outputDir, 'k6-timeseries.json');
    try {
      const outputArg = includeTimeseries ? ' --out json=timeseries.json' : '';
      const startedAt = Date.now();
      const remote = await execa('ssh', [...ssh, host,
        `cd ${quote(remoteDir)} && ulimit -f ${artifactLimitBlocks} && ${assignments} timeout ${config.durationSeconds + 60}s k6 run --summary-export summary.json${outputArg} --no-color ${quote(workloadFile)}`,
      ], { reject: false, ...(config.signal ? { cancelSignal: config.signal } : {}), timeout: (config.durationSeconds + 120) * 1000 });
      const actualDurationSeconds = (Date.now() - startedAt) / 1000;
      const cpuAfter = await remoteCpuSnapshot(host, ssh);
      await execa('scp', [...scp, `${host}:${remoteDir}/summary.json`, summaryPath]);
      if (includeTimeseries) await execa('scp', [...scp, `${host}:${remoteDir}/timeseries.json`, timeseriesPath], { reject: false });
      if (remote.exitCode !== 0 && remote.exitCode !== 99) {
        throw new Error(`Remote k6 exited with ${remote.exitCode}: ${remote.stderr.slice(0, 2000)}`);
      }
      return parseSummary(summaryPath, actualDurationSeconds, remote.exitCode ?? 0, logger, cpuPercent(cpuBefore, cpuAfter));
    } finally {
      await execa('ssh', [...ssh, host, `rm -rf -- ${quote(remoteDir)}`], { reject: false, timeout: 15_000 }).catch((error) => {
        logger.warn({ error, remoteDir }, 'Remote artifact cleanup failed');
      });
    }
  }
}

export async function runK6Load(config: LoadRunnerConfig, logger: Logger): Promise<LoadRunnerResult> {
  const runner: K6Runner = process.env['LOAD_RUNNER_MODE'] === 'ssh' ? new SshK6Runner() : new LocalK6Runner();
  return runner.run(config, logger);
}

async function runLocalK6Load(
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
  const includeTimeseries = shouldWriteTimeseries(config.targetRps);
  const vus = vuAllocation(config);

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
    PRE_ALLOCATED_VUS: String(vus.preAllocated),
    MAX_VUS: String(vus.max),
    E2E_POLL_SAMPLE_RATE: String(e2ePollSampleRate(config.targetRps)),
    PRODUCT_IDS: JSON.stringify(config.productIds),
    USER_IDS: JSON.stringify(config.userIds),
  };

  const args = ['run', '--summary-export', summaryPath];
  writeLoadConfiguration(config, env, includeTimeseries, 'local');
  if (includeTimeseries) args.push('--out', `json=${timeseriesPath}`);
  args.push('--no-color', scriptPath);

  try {
    const startedAt = Date.now();
    const cpuBefore = localCpuSnapshot();
    const artifactAbort = new AbortController();
    const artifactLimit = maxArtifactFileBytes();
    let artifactLimitExceeded = false;
    const artifactMonitor = setInterval(() => {
      if (includeTimeseries && existsSync(timeseriesPath) && statSync(timeseriesPath).size > artifactLimit) {
        artifactLimitExceeded = true;
        artifactAbort.abort(new Error('k6 timeseries artifact limit exceeded'));
      }
    }, 1000);
    artifactMonitor.unref();
    const combinedSignal = config.signal
      ? AbortSignal.any([config.signal, artifactAbort.signal])
      : artifactAbort.signal;
    const processOptions: Options = {
      env,
      timeout: (config.warmupSeconds + config.durationSeconds + config.cooldownSeconds + 120) * 1000,
      reject: false,
      cancelSignal: combinedSignal,
    };
    let result;
    try {
      result = await execa(k6Bin, args, processOptions);
    } catch (error) {
      if (artifactLimitExceeded) {
        if (existsSync(timeseriesPath)) truncateSync(timeseriesPath, artifactLimit);
        writeFileSync(path.join(config.outputDir, 'artifact-limit.json'), JSON.stringify({
          code: 'K6_ARTIFACT_LIMIT_EXCEEDED', maxBytes: artifactLimit, artifact: 'k6-timeseries.json',
        }, null, 2));
        throw new Error(`k6 timeseries exceeded the ${artifactLimit}-byte artifact limit`, { cause: error });
      }
      throw error;
    } finally {
      clearInterval(artifactMonitor);
    }
    const cpuAfter = localCpuSnapshot();

    const actualDurationSeconds = (Date.now() - startedAt) / 1000;
    // k6 uses exit 99 when a threshold is crossed. That is a valid
    // measurement and must flow into hard-gate evaluation, not become an
    // infrastructure failure. Other non-zero exits remain fatal.
    if (result.exitCode !== 0 && !(result.exitCode === 99 && existsSync(summaryPath))) {
      throw new Error(`k6 exited with ${result.exitCode}: ${String(result.stderr).slice(0, 2000)}`);
    }

    // Parse summary
    if (existsSync(summaryPath)) {
      const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
      const metrics = summary.metrics || {};

      const httpDuration = metrics['operation_latency'] || metrics['http_req_duration'] || {};
      const httpFailed = metrics['http_req_failed'] || {};
      const requests = metrics['http_reqs'] || {};
      const iterations = metrics['iterations'] || {};
      const droppedIter = metrics['dropped_iterations'] || {};
      const durationValues = httpDuration.values ?? httpDuration;
      const failedValues = httpFailed.values ?? httpFailed;
      const requestValues = requests.values ?? requests;
      const iterationValues = iterations.values ?? iterations;
      const droppedValues = droppedIter.values ?? droppedIter;

      const p50 = durationValues['p(50)'] ?? durationValues.med ?? 0;
      const p95 = durationValues['p(95)'] ?? 0;
      const p99 = durationValues['p(99)'] ?? 0;
      const avg = durationValues.avg ?? 0;
      const max = durationValues.max ?? 0;

      const totalRequests = requestValues.count ?? 0;
      const totalIterations = iterationValues.count ?? 0;
      const achievedRps = iterationValues.rate ?? 0;
      const achievedHttpRps = requestValues.rate ?? 0;
      const droppedCount = droppedValues.count ?? 0;
      const failRate = failedValues.rate ?? failedValues.value ?? 0;
      const rate = (name: string): number => {
        const raw = metrics[name] || {};
        const values = raw.values ?? raw;
        return values.rate ?? values.value ?? 0;
      };

      logger.info({
        p50: p50.toFixed(2),
        p95: p95.toFixed(2),
        p99: p99.toFixed(2),
        totalRequests,
        totalIterations,
        achievedRps: achievedRps.toFixed(2),
        achievedHttpRps: achievedHttpRps.toFixed(2),
        droppedIterations: droppedCount,
        failRate: failRate.toFixed(4),
      }, 'k6 load test completed');

      return {
        measurementSchemaVersion: '2.0.0',
        summaryJsonPath: summaryPath,
        droppedIterations: droppedCount,
        totalIterations,
        totalRequests,
        httpReqDuration: { p50, p95, p99, avg, max },
        httpReqFailed: failRate,
        errorBreakdown: {
          http5xxRate: rate('http_5xx_rate'),
          http4xxUnexpectedRate: rate('http_4xx_unexpected_rate'),
          networkErrorRate: rate('network_error_rate'),
          timeoutRate: rate('timeout_rate'),
          businessErrorRate: rate('business_error_rate'),
        },
        achievedRps,
        achievedHttpRps,
        checkoutAcceptanceRate: rate('checkout_acceptance_rate'),
        checkoutConfirmationSamples: (metrics['checkout_confirmation_samples']?.values ?? metrics['checkout_confirmation_samples'])?.count ?? 0,
        checkoutSampledConfirmationRate: metrics['checkout_sampled_confirmation_rate'] ? rate('checkout_sampled_confirmation_rate') : null,
        checkoutSampledUnsettledRate: metrics['checkout_sampled_unsettled_rate'] ? rate('checkout_sampled_unsettled_rate') : null,
        stockoutRate: rate('stockout_rate'),
        measurementDurationSeconds: actualDurationSeconds,
        exitCode: result.exitCode,
        loadHostCpuPercent: cpuPercent(cpuBefore, cpuAfter),
      };
    }
    throw new Error(`k6 did not produce summary artifact ${summaryPath}`);
  } catch (err: unknown) {
    logger.error({ err }, 'k6 execution failed');
    throw err;
  }
}

function maxArtifactFileBytes(): number {
  const value = Number(process.env['MAX_ARTIFACT_FILE_BYTES'] ?? 536_870_912);
  if (!Number.isSafeInteger(value) || value < 1_048_576) {
    throw new Error('MAX_ARTIFACT_FILE_BYTES must be an integer of at least 1048576');
  }
  return value;
}

function parseSummary(summaryPath: string, actualDurationSeconds: number, exitCode: number, logger: Logger, loadHostCpuPercent: number): LoadRunnerResult {
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as { metrics?: Record<string, { values?: Record<string, number>; [key: string]: unknown }> };
  const metric = (name: string): Record<string, number> => {
    const raw = summary.metrics?.[name] ?? {};
    return (raw.values ?? raw) as Record<string, number>;
  };
  const duration = metric(summary.metrics?.['operation_latency'] ? 'operation_latency' : 'http_req_duration');
  const failed = metric('http_req_failed');
  const requests = metric('http_reqs');
  const iterations = metric('iterations');
  const dropped = metric('dropped_iterations');
  const rate = (name: string): number => {
    const values = metric(name);
    return values['rate'] ?? values['value'] ?? 0;
  };
  const result: LoadRunnerResult = {
    measurementSchemaVersion: '2.0.0',
    summaryJsonPath: summaryPath,
    droppedIterations: dropped['count'] ?? 0,
    totalIterations: iterations['count'] ?? 0,
    totalRequests: requests['count'] ?? 0,
    httpReqDuration: { p50: duration['p(50)'] ?? duration['med'] ?? 0, p95: duration['p(95)'] ?? 0,
      p99: duration['p(99)'] ?? 0, avg: duration['avg'] ?? 0, max: duration['max'] ?? 0 },
    httpReqFailed: failed['rate'] ?? failed['value'] ?? 0,
    errorBreakdown: {
      http5xxRate: rate('http_5xx_rate'),
      http4xxUnexpectedRate: rate('http_4xx_unexpected_rate'),
      networkErrorRate: rate('network_error_rate'),
      timeoutRate: rate('timeout_rate'),
      businessErrorRate: rate('business_error_rate'),
    },
    achievedRps: iterations['rate'] ?? 0,
    achievedHttpRps: requests['rate'] ?? 0,
    checkoutAcceptanceRate: rate('checkout_acceptance_rate'),
    checkoutConfirmationSamples: metric('checkout_confirmation_samples')['count'] ?? 0,
    checkoutSampledConfirmationRate: summary.metrics?.['checkout_sampled_confirmation_rate'] ? rate('checkout_sampled_confirmation_rate') : null,
    checkoutSampledUnsettledRate: summary.metrics?.['checkout_sampled_unsettled_rate'] ? rate('checkout_sampled_unsettled_rate') : null,
    stockoutRate: rate('stockout_rate'),
    measurementDurationSeconds: actualDurationSeconds,
    exitCode,
    loadHostCpuPercent,
  };
  logger.info({ totalIterations: result.totalIterations, totalRequests: result.totalRequests, achievedRps: result.achievedRps,
    achievedHttpRps: result.achievedHttpRps }, 'Remote k6 load test completed');
  return result;
}

interface CpuSnapshot { idle: number; total: number }
function localCpuSnapshot(): CpuSnapshot {
  return os.cpus().reduce((result, cpu) => {
    const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    return { idle: result.idle + cpu.times.idle, total: result.total + total };
  }, { idle: 0, total: 0 });
}
async function remoteCpuSnapshot(host: string, ssh = sshArguments(host)): Promise<CpuSnapshot> {
  const result = await execa('ssh', [...ssh, host, "awk '/^cpu /{idle=$5+$6; total=0; for(i=2;i<=NF;i++) total+=$i; print idle, total}' /proc/stat"], { timeout: 15_000 });
  const [idle, total] = result.stdout.trim().split(/\s+/).map(Number);
  if (!Number.isFinite(idle) || !Number.isFinite(total)) throw new Error('Unable to read load-host CPU counters');
  return { idle: idle!, total: total! };
}

function numericEnv(name: string, fallback: number, minimum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${name} must be at least ${minimum}`);
  return value;
}

function vuAllocation(config: LoadRunnerConfig): { preAllocated: number; max: number } {
  const defaults: Record<string, number> = { BROWSING_V1: 0.15, MIXED_V1: 0.30, CHECKOUT_V1: 0.40, FLASH_SALE_V1: 0.25 };
  const expectedSeconds = numericEnv('K6_EXPECTED_ITERATION_SECONDS', defaults[config.workloadProfile] ?? 0.3, 0.01);
  const headroom = numericEnv('K6_VU_HEADROOM', 1.5, 1);
  const maxMultiplier = numericEnv('K6_MAX_VUS_MULTIPLIER', 2, 1);
  const cap = Math.floor(numericEnv('K6_MAX_VUS_CAP', 20_000, 50));
  const preAllocated = Math.min(cap, Math.max(50, Math.ceil(config.targetRps * expectedSeconds * headroom)));
  return { preAllocated, max: Math.min(cap, Math.max(preAllocated, Math.ceil(preAllocated * maxMultiplier))) };
}

function shouldWriteTimeseries(targetRps: number): boolean {
  const mode = (process.env['K6_TIMESERIES_MODE'] ?? 'auto').toLowerCase();
  if (!['auto', 'full', 'summary'].includes(mode)) throw new Error('K6_TIMESERIES_MODE must be auto, full, or summary');
  return mode === 'full' || (mode === 'auto' && targetRps <= numericEnv('K6_FULL_TIMESERIES_MAX_RPS', 500, 1));
}

function e2ePollSampleRate(_targetRps: number): number {
  const configured = process.env['K6_E2E_POLL_SAMPLE_RATE'];
  if (configured !== undefined) {
    const value = numericEnv('K6_E2E_POLL_SAMPLE_RATE', 0.01, 0);
    if (value > 1) throw new Error('K6_E2E_POLL_SAMPLE_RATE must not exceed 1');
    return value;
  }
  // Freeze polling overhead across load levels instead of changing the workload.
  return 0.01;
}

function writeLoadConfiguration(config: LoadRunnerConfig, env: Record<string, string>, timeseries: boolean, mode: string): void {
  writeFileSync(path.join(config.outputDir, 'load-configuration.json'), JSON.stringify({
    measurementSchemaVersion: '2.0.0',
    mode, offeredOperationsPerSecond: config.targetRps, scheduledDurationSeconds: config.durationSeconds,
    sutBaseUrl: env['SUT_BASE_URL'], workload: config.workloadProfile,
    preAllocatedVUs: Number(env['PRE_ALLOCATED_VUS']), maxVUs: Number(env['MAX_VUS']),
    e2ePollSampleRate: Number(env['E2E_POLL_SAMPLE_RATE']), timeseries,
    latencyPopulation: 'primary HTTP operations; excludes status polling',
    throughputPopulation: 'completed k6 iterations; includes unsuccessful operations',
    checkoutAcceptanceDefinition: 'HTTP 201 or 202; does not imply confirmed payment or settlement',
    productCount: config.productIds.length, userCount: config.userIds.length,
  }, null, 2));
}

function sshArguments(_host: string): string[] {
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
  const key = process.env['LOAD_HOST_SSH_KEY'];
  if (key) args.push('-i', key);
  return args;
}

function scpArguments(): string[] {
  const args = sshArguments('');
  const key = process.env['LOAD_HOST_SSH_KEY'];
  if (key) args.push('-i', key);
  return args;
}

function remoteSutBaseUrl(localUrl: string): string {
  const hostname = process.env['LOAD_HOST_SUT_HOST'];
  if (!hostname) return localUrl;
  const parsed = new URL(localUrl);
  parsed.hostname = hostname;
  return parsed.toString().replace(/\/$/, '');
}
function cpuPercent(before: CpuSnapshot, after: CpuSnapshot): number {
  const total = after.total - before.total;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - (after.idle - before.idle) / total) * 100));
}
