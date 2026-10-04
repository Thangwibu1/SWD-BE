import { getEvaluatorDb } from '../metadata/sqlite.js';
import { LeaseManager } from './lease-manager.js';
import { ExperimentStateMachine } from './experiment-state-machine.js';
import type { Logger } from '../utils/logger.js';
import type { AppConfig } from '../config/env.js';
import { validateCandidate } from '../evaluator/architecture-validator/index.js';
import { loadRegistry } from '../evaluator/registry/index.js';
import { renderCompose } from '../evaluator/compose-renderer/index.js';
import { deployCompose, cleanupCompose, getComposeLogs, healthCheck, inspectComposeHealth } from '../evaluator/docker-runner/index.js';
import { runK6Load } from '../evaluator/load-runner/index.js';
import { collectApplicationMetrics, collectContainerStatsSeries, collectPrometheusMetrics, configurePrometheusSutTarget, saveMetricsArtifacts } from '../evaluator/metrics-collector/index.js';
import { runInvariantOracle } from '../evaluator/invariant-oracle/index.js';
import { loadCostCatalog, computeCost } from '../evaluator/cost-engine/index.js';
import { computeGates, computeScores, loadNormalizationBounds } from '../evaluator/score-engine/index.js';
import { buildManifest, buildReport } from '../evaluator/report-builder/index.js';
import path from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import crypto from 'node:crypto';
import os from 'node:os';
import { flushExternalState, restoreComposeDataset } from '../evaluator/dataset-manager/index.js';
import { monitorCancellation, RunCancelledError, throwIfCancellationRequested, waitWithCancellation } from './cancellation.js';

export class WorkerLoop {
  private isRunning = false;
  private leaseManager: LeaseManager;

  constructor(private workerId: string, private logger: Logger) {
    this.leaseManager = new LeaseManager(workerId);
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.info('Worker started');
    this.loop();
  }

  stop(): void {
    this.isRunning = false;
    this.logger.info('Worker stopping');
  }

  private async loop(): Promise<void> {
    while (this.isRunning) {
      try {
        const runId = this.findPendingRun();
        if (runId) {
          await this.processRun(runId);
        } else {
          // Sleep before polling again
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      } catch (err) {
        this.logger.error({ err }, 'Worker loop error');
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  private findPendingRun(): string | null {
    const db = getEvaluatorDb();
    const now = new Date().toISOString();

    // Find a run that is PENDING, or one that was abandoned (lease expired)
    const run = db.prepare(`
      SELECT id FROM experiment_runs
      WHERE state IN ('PENDING', 'VALIDATING', 'PREPARING', 'DEPLOYING', 'READY_CHECK', 'SMOKE_TESTING', 'WARMING_UP', 'RUNNING', 'COLLECTING', 'VERIFYING', 'SCORING', 'CLEANING')
        AND (lease_until IS NULL OR lease_until < ?)
      ORDER BY run_number ASC LIMIT 1
    `).get(now) as { id: string } | undefined;

    if (!run) return null;

    // Try to acquire lease
    if (this.leaseManager.acquireLease(run.id)) {
      return run.id;
    }

    return null;
  }

  private async processRun(runId: string): Promise<void> {
    const stateMachine = new ExperimentStateMachine(runId, this.logger);
    const db = getEvaluatorDb();

    let composePath: string | undefined;
    let projectName: string | undefined;
    let outcome: 'COMPLETED' | 'FAILED' | 'CANCEL_REQUESTED' | 'CLEANUP_FAILED' = 'FAILED';
    let failureMessage: string | undefined;
    let cleanupSucceeded = true;
    let leaseLost: Error | undefined;
    let activeLoadAbort: AbortController | null = null;
    let runDir: string | undefined;
    const stopLeaseHeartbeat = this.leaseManager.startHeartbeat(runId, (error) => {
      leaseLost = error;
      activeLoadAbort?.abort(error);
      this.logger.error({ runId, err: error }, 'Run lease heartbeat failed');
    });
    const resultsRoot = process.env['RESULTS_ROOT'] || './results';

    try {
      this.logger.info({ runId }, 'Processing run');

      // Load experiment configuration
      const runRow = db.prepare('SELECT experiment_id, run_number, load_rps, attempt FROM experiment_runs WHERE id = ?').get(runId) as {
        experiment_id: string; run_number: number; load_rps: number; attempt: number;
      };
      db.prepare("UPDATE experiments SET status = 'RUNNING', updated_at = ? WHERE id = ?").run(new Date().toISOString(), runRow.experiment_id);
      const expRow = db.prepare('SELECT name, candidate_id, workload_profile, warmup_seconds, measure_seconds, cooldown_seconds, slo_json, cost_catalog_version, score_bounds_version, protocol_version, invalid_retry_limit, dataset_profile FROM experiments WHERE id = ?').get(runRow.experiment_id) as {
        name: string;
        candidate_id: string;
        workload_profile: string;
        warmup_seconds: number;
        measure_seconds: number;
        cooldown_seconds: number;
        slo_json: string;
        cost_catalog_version: string;
        score_bounds_version: string;
        protocol_version: string | null;
        invalid_retry_limit: number;
        dataset_profile: 'pilot' | 'main' | 'capacity';
      };
      const candidateRow = db.prepare('SELECT raw_json, architecture_id FROM candidates WHERE id = ?').get(expRow.candidate_id) as { raw_json: string; architecture_id: string };

      const candidateJson = JSON.parse(candidateRow.raw_json);
      const slo = JSON.parse(expRow.slo_json);

      // Setup result directory
      runDir = path.join(resultsRoot, runRow.experiment_id, runId);
      mkdirSync(runDir, { recursive: true });
      mkdirSync(path.join(runDir, 'input'), { recursive: true });
      mkdirSync(path.join(runDir, 'raw'), { recursive: true });

      writeFileSync(path.join(runDir, 'input', 'candidate.json'), candidateRow.raw_json);
      writeFileSync(path.join(runDir, 'input', 'experiment.json'), JSON.stringify({
        name: expRow.name,
        workloadProfile: expRow.workload_profile,
        loadRps: runRow.load_rps,
        warmupSeconds: expRow.warmup_seconds,
        measureSeconds: expRow.measure_seconds,
        cooldownSeconds: expRow.cooldown_seconds,
        slo,
        costCatalogVersion: expRow.cost_catalog_version,
        scoreBoundsVersion: expRow.score_bounds_version,
        protocolVersion: expRow.protocol_version,
        datasetProfile: expRow.dataset_profile,
      }, null, 2));

      // Phase: VALIDATING
      throwIfCancellationRequested(runId);
      stateMachine.transitionTo('VALIDATING');
      const valResult = validateCandidate(candidateJson);
      if (!valResult.valid) {
        throw new Error(`Validation failed: ${valResult.code}`);
      }

      // Phase: PREPARING
      stateMachine.transitionTo('PREPARING');
      throwIfCancellationRequested(runId);
      const registry = loadRegistry();
      const profile = registry.get(candidateRow.architecture_id);
      if (!profile) {
        throw new Error(`Unknown architecture: ${candidateRow.architecture_id}`);
      }

      writeFileSync(path.join(runDir, 'input', 'resolved-profile.yaml'), JSON.stringify(profile, null, 2));

      const renderResult = renderCompose({
        runId,
        profile,
        databaseUrl: 'postgres://bench:bench@postgres:5432/ecommerce',
        hostPortStart: allocatePortPair(
          runId,
          Number(process.env['SUT_PORT_RANGE_START'] ?? 20000),
          Number(process.env['SUT_PORT_RANGE_END'] ?? 21000),
        ),
        outputDir: runDir,
      });
      composePath = renderResult.filePath;
      projectName = `bench-${runId}`;

      // Phase: DEPLOYING
      stateMachine.transitionTo('DEPLOYING');
      throwIfCancellationRequested(runId);
      // A stale exact-name stack may remain after a worker/process crash. The
      // cleanup is intentionally scoped to this run ID and happens before
      // redeploying so recovery never reuses mutated SUT state.
      await cleanupCompose({ runId, composeFilePath: composePath, logger: this.logger });
      await deployCompose({ runId, composeFilePath: composePath, logger: this.logger });

      const sutHost = renderResult.controlHost ?? process.env['SUT_HOST'] ?? '127.0.0.1';
      const sutPort = renderResult.controlHost ? 3000 : renderResult.hostPort;
      const databaseHost = renderResult.controlDatabaseHost ?? sutHost;
      const databasePort = renderResult.controlDatabaseHost ? 5432 : renderResult.postgresHostPort;
      const sutDatabaseUrl = `postgres://bench:bench@${databaseHost}:${databasePort}/ecommerce`;
      await restoreComposeDataset({
        runId,
        composeFilePath: composePath,
        databaseUrl: sutDatabaseUrl,
        profile: expRow.dataset_profile,
        logger: this.logger,
      });
      await flushExternalState(projectName, profile.cache.enabled, profile.messaging.enabled, this.logger);

      // Phase: READY_CHECK
      stateMachine.transitionTo('READY_CHECK');
      throwIfCancellationRequested(runId);
      const sutBaseUrl = `http://${sutHost}:${sutPort}`;
      // Remote k6 must use the published host port, never a Docker DNS alias.
      const loadBaseUrl = process.env['LOAD_RUNNER_MODE'] === 'ssh'
        ? `http://${process.env['LOAD_HOST_SUT_HOST'] ?? sutHost}:${renderResult.hostPort}`
        : sutBaseUrl;
      configurePrometheusSutTarget(
        sutPort,
        renderResult.controlHost ?? process.env['PROMETHEUS_SUT_HOST'] ?? 'host.docker.internal',
      );
      await healthCheck(sutBaseUrl, 120000, this.logger);

      // Phase: SMOKE_TESTING
      stateMachine.transitionTo('SMOKE_TESTING');
      await runFunctionalSmoke(sutBaseUrl);
      if (leaseLost) throw leaseLost;

      const ids = await loadWorkloadIds(sutDatabaseUrl);

      // Phase: WARMING_UP
      stateMachine.transitionTo('WARMING_UP');
      if (expRow.warmup_seconds > 0) {
        const warmupAbort = new AbortController();
        activeLoadAbort = warmupAbort;
        const stopWarmupCancellation = monitorCancellation(runId, warmupAbort);
        try {
          // Warm-up uses the exact selected workload and target arrival rate.
          // Its output is archived separately and never enters official metrics.
          await runK6Load({
            workloadProfile: expRow.workload_profile,
            targetRps: runRow.load_rps,
            durationSeconds: expRow.warmup_seconds,
            warmupSeconds: 0,
            cooldownSeconds: 0,
            sutBaseUrl: loadBaseUrl,
            productIds: ids.productIds,
            userIds: ids.userIds,
            outputDir: path.join(runDir, 'raw', 'warmup'),
            signal: warmupAbort.signal,
          }, this.logger);
        } finally {
          stopWarmupCancellation();
          activeLoadAbort = null;
        }
      }
      if (leaseLost) throw leaseLost;

      // Phase: RUNNING
      stateMachine.transitionTo('RUNNING');

      const monitorAbort = new AbortController();
      const loadAbort = new AbortController();
      activeLoadAbort = loadAbort;
      const stopCancellationMonitor = monitorCancellation(runId, loadAbort);
      const statsPromise = collectContainerStatsSeries(projectName, monitorAbort.signal, this.logger);
      const measurementStartedAt = new Date();

      let loadResult;
      try {
        loadResult = await runK6Load({
          workloadProfile: expRow.workload_profile,
          targetRps: runRow.load_rps,
          durationSeconds: expRow.measure_seconds,
          warmupSeconds: 0,
          cooldownSeconds: expRow.cooldown_seconds,
          sutBaseUrl: loadBaseUrl,
          productIds: ids.productIds,
          userIds: ids.userIds,
          outputDir: path.join(runDir, 'raw'),
          signal: loadAbort.signal,
        }, this.logger);
      } finally {
        stopCancellationMonitor();
        monitorAbort.abort();
        activeLoadAbort = null;
      }
      const containerStats = await statsPromise;
      const measurementEndedAt = new Date();
      if (leaseLost) throw leaseLost;

      // Phase: COLLECTING
      stateMachine.transitionTo('COLLECTING');
      throwIfCancellationRequested(runId);
      const prometheusUrl = process.env['PROMETHEUS_URL'] || 'http://localhost:9090';
      const prometheusMetrics = await collectPrometheusMetrics(
        prometheusUrl,
        projectName,
        measurementStartedAt,
        measurementEndedAt,
        this.logger
      );
      const applicationMetrics = await collectApplicationMetrics(sutBaseUrl, this.logger, projectName);
      saveMetricsArtifacts(runDir, containerStats, prometheusMetrics, applicationMetrics, this.logger);
      const containerHealth = await inspectComposeHealth(projectName, this.logger);
      if (expRow.cooldown_seconds > 0) {
        await waitWithCancellation(runId, expRow.cooldown_seconds * 1000);
      }

      // Phase: VERIFYING
      stateMachine.transitionTo('VERIFYING');
      throwIfCancellationRequested(runId);
      const invariantResult = await runInvariantOracle(
        sutDatabaseUrl,
        runId,
        this.logger,
        sutBaseUrl,
        Number(process.env['EVENTUAL_TIMEOUT_MS'] ?? 5000),
      );
      writeFileSync(
        path.join(runDir, 'raw', 'invariant-output.json'),
        JSON.stringify(invariantResult, null, 2)
      );

      // Phase: SCORING
      stateMachine.transitionTo('SCORING');
      throwIfCancellationRequested(runId);

      // Compute cost
      const catalog = loadCostCatalog(expRow.cost_catalog_version);
      const allocations = Object.values(profile.resources ?? {});
      const totalVCPU = allocations.reduce((sum, resource) => sum + resource.cpus, 0);
      const totalMemoryGiB = allocations.reduce((sum, resource) => sum + resource.memoryMiB, 0) / 1024;

      const cost = computeCost(
        catalog,
        {
          totalVCPU,
          totalMemoryGiB,
          hasRedis: profile.cache.enabled,
          hasRabbitMQ: profile.messaging.enabled,
          hasLoadBalancer: profile.allowedRoles.includes('api-gateway'),
          replicaCount: profile.allowedRoles.filter((role) => role.includes('replica')).length + 1,
          storageGiB: 10,
          egressGiBPerMonth: 50,
        },
        profile.family,
        profile.cache.enabled,
        profile.messaging.enabled,
        this.logger
      );

      // Compute gates
      const expectedSamples = Math.max(1, Math.floor(expRow.measure_seconds / 2));
      const containerCoverage = Math.min(100, (containerStats.length / expectedSamples) * 100);
      const prometheusCoverage = ('http_requests_total' in prometheusMetrics
        || 'cpu_usage_seconds' in prometheusMetrics) ? 100 : 0;
      const applicationCoverage = applicationMetrics.includes('http_server_requests_total') ? 100 : 0;
      const metricCoveragePercent = Math.min(containerCoverage, prometheusCoverage, applicationCoverage);
      const gates = computeGates(loadResult, invariantResult, {
        ...slo,
        consistencyViolationsMax: slo.consistencyViolationsMax ?? 0,
      }, this.logger, {
        measurementDurationSeconds: loadResult.measurementDurationSeconds,
        sampleCount: loadResult.totalIterations,
        metricCoveragePercent,
        loadHostCpuPercent: loadResult.loadHostCpuPercent,
        expectedMeasurementDurationSeconds: expRow.measure_seconds,
        // Underdelivery is evaluated as capacity failure, not invalid evidence.
        minimumSampleCount: 1,
        offeredRps: runRow.load_rps,
        achievedOperationRps: loadResult.achievedRps,
        oomKills: containerHealth.oomKills,
        unexpectedCrashes: containerHealth.unexpectedCrashes,
      });

      const bounds = loadNormalizationBounds(expRow.score_bounds_version);

      const cpuEfficiency = loadResult.totalIterations / (totalVCPU * expRow.measure_seconds || 1);
      const memoryPeakMiB = Math.max(0, ...containerStats.map((sample) =>
        sample.containers.reduce((sum, item) => sum + item.memoryUsageMiB, 0)));
      const scores = computeScores(
        {
          p99Ms: loadResult.httpReqDuration.p99,
          errorRate: loadResult.httpReqFailed,
          achievedRps: loadResult.achievedRps,
          cpuEfficiency,
          memoryPeakMiB,
          costMonth: cost.infraMonth,
          consistencyViolations: invariantResult.violations.length,
        },
        bounds,
        Array.isArray(candidateJson.priorities) ? candidateJson.priorities : [],
        this.logger,
        slo.p99Ms,
      );
      const derivedMetrics = {
        ...loadResult,
        p50Ms: loadResult.httpReqDuration.p50,
        p95Ms: loadResult.httpReqDuration.p95,
        p99Ms: loadResult.httpReqDuration.p99,
        errorRate: loadResult.httpReqFailed,
        cpuEfficiency,
        memoryPeakMiB,
        metricCoveragePercent,
        containerHealth,
        prometheus: prometheusMetrics,
      };

      buildReport(runDir, {
        experimentName: expRow.name,
        architectureId: candidateRow.architecture_id,
        scoreBoundsVersion: expRow.score_bounds_version,
        protocolVersion: expRow.protocol_version,
        workload: expRow.workload_profile,
        loadRps: runRow.load_rps,
        metrics: derivedMetrics as unknown as Record<string, unknown>,
        cost: cost as unknown as Record<string, unknown>,
        gates: gates as unknown as Record<string, unknown>,
        scores: scores as unknown as Record<string, unknown>,
        invariants: invariantResult as unknown as Record<string, unknown>,
        generatedAt: measurementEndedAt.toISOString(),
        limitations: ['Single-host synthetic benchmark; projected cost depends on the frozen catalog.'],
      }, this.logger);

      writeFileSync(path.join(runDir, 'environment.json'), JSON.stringify({
        node: process.version,
        platform: process.platform,
        platformRelease: os.release(),
        cpuModel: os.cpus()[0]?.model ?? 'unknown',
        logicalCpuCount: os.cpus().length,
        totalMemoryMiB: Math.round(os.totalmem() / 1024 / 1024),
        architectureId: candidateRow.architecture_id,
        datasetProfile: expRow.dataset_profile,
        protocolVersion: expRow.protocol_version,
        costCatalogVersion: expRow.cost_catalog_version,
        scoreBoundsVersion: expRow.score_bounds_version,
        backendImage: process.env['BACKEND_IMAGE_DIGEST'] ?? 'architecture-evaluation-backend:0.1.0',
        loadRunnerMode: process.env['LOAD_RUNNER_MODE'] ?? 'local',
        loadHostCpuPercent: loadResult.loadHostCpuPercent,
        measurementStartedAt: measurementStartedAt.toISOString(),
        measurementEndedAt: measurementEndedAt.toISOString(),
      }, null, 2));
      writeFileSync(path.join(runDir, 'raw', 'compose.log'), await getComposeLogs({ runId, composeFilePath: composePath, logger: this.logger }));
      const manifest = buildManifest(runDir, runRow.experiment_id, runId, this.logger, measurementEndedAt.toISOString());
      const insertArtifact = db.prepare(`INSERT INTO artifacts
        (id, run_id, type, relative_path, sha256, size_bytes) VALUES (?, ?, ?, ?, ?, ?)`);
      db.transaction(() => {
        db.prepare('DELETE FROM artifacts WHERE run_id = ?').run(runId);
        for (const artifact of manifest.artifacts) {
          insertArtifact.run(crypto.randomUUID(), runId, artifact.type, artifact.relativePath, artifact.sha256, artifact.sizeBytes);
        }
      })();

      // Store in database
      db.prepare(`UPDATE experiment_runs SET
        completed_at = ?,
        metrics_json = ?,
        cost_json = ?,
        gates_json = ?,
        scores_json = ?
      WHERE id = ?`).run(
        new Date().toISOString(),
        JSON.stringify(derivedMetrics),
        JSON.stringify(cost),
        JSON.stringify(gates),
        JSON.stringify(scores),
        runId
      );

      const infrastructureInvalid = gates.gates.some((gate) =>
        !gate.passed && ['GATE_MEASUREMENT_VALID', 'GATE_LOAD_GENERATOR_CPU'].includes(gate.code));
      if (infrastructureInvalid) {
        if (runRow.attempt < expRow.invalid_retry_limit) {
          db.prepare(`INSERT INTO experiment_runs (id, experiment_id, run_number, load_rps, state, attempt)
            VALUES (?, ?, ?, ?, 'PENDING', ?)`).run(
            crypto.randomUUID(), runRow.experiment_id, runRow.run_number, runRow.load_rps, runRow.attempt + 1,
          );
          db.prepare("UPDATE experiment_runs SET failure_code = 'INFRA_INVALID_RETRIED', failure_message = ? WHERE id = ?")
            .run('Infrastructure-invalid evidence archived; one deterministic retry queued', runId);
          outcome = 'FAILED';
          failureMessage = 'Infrastructure-invalid run retried';
        } else {
          db.prepare("UPDATE experiment_runs SET failure_code = 'INFRA_INVALID_EXHAUSTED', failure_message = ? WHERE id = ?")
            .run('Infrastructure-invalid measurement after deterministic retry', runId);
          outcome = 'FAILED';
          failureMessage = 'Infrastructure-invalid retry exhausted';
        }
      } else {
        outcome = 'COMPLETED';
      }

    } catch (err) {
      const error = err as Error;
      const cancelled = error instanceof RunCancelledError || error.name === 'AbortError';
      this.logger.error({ runId, err: error }, 'Run failed');
      db.prepare("UPDATE experiment_runs SET completed_at = ?, failure_code = ?, failure_message = ? WHERE id = ?").run(
        new Date().toISOString(),
        cancelled ? 'CANCELLED_BY_USER' : 'INTERNAL_ERROR',
        sanitizeFailureMessage(error.message),
        runId
      );
      failureMessage = sanitizeFailureMessage(error.message);
      outcome = cancelled ? 'CANCEL_REQUESTED' : 'FAILED';
    } finally {
      // Phase: CLEANING
      if (composePath) {
        stateMachine.transitionTo('CLEANING');
        try {
          try {
            if (runDir && !existsSync(path.join(runDir, 'raw', 'compose.log'))) {
              writeFileSync(path.join(runDir, 'raw', 'compose.log'), await getComposeLogs({ runId, composeFilePath: composePath, logger: this.logger }));
            }
          } catch (logError) {
            this.logger.warn({ runId, err: logError }, 'Unable to capture Compose logs');
          }
          await cleanupCompose({ runId, composeFilePath: composePath, logger: this.logger });
        } catch (cleanupErr) {
          const cleanupError = cleanupErr as Error;
          this.logger.error({ runId, err: cleanupError }, 'Cleanup failed');
          cleanupSucceeded = false;
          outcome = 'CLEANUP_FAILED';
          failureMessage = sanitizeFailureMessage(`Cleanup failed: ${cleanupError.message}`);
        }
      }
      stateMachine.transitionTo(outcome, failureMessage);
      const run = db.prepare('SELECT experiment_id FROM experiment_runs WHERE id = ?').get(runId) as { experiment_id: string };
      if (runDir && !existsSync(path.join(runDir, 'manifest.json'))) {
        const failureManifest = buildManifest(runDir, run.experiment_id, runId, this.logger);
        const insertArtifact = db.prepare(`INSERT INTO artifacts
          (id, run_id, type, relative_path, sha256, size_bytes) VALUES (?, ?, ?, ?, ?, ?)`);
        db.transaction(() => {
          db.prepare('DELETE FROM artifacts WHERE run_id = ?').run(runId);
          for (const artifact of failureManifest.artifacts) {
            insertArtifact.run(crypto.randomUUID(), runId, artifact.type, artifact.relativePath, artifact.sha256, artifact.sizeBytes);
          }
        })();
      }
      updateParentExperimentStatus(run.experiment_id);
      stopLeaseHeartbeat();
      if (cleanupSucceeded) this.leaseManager.releaseLease(runId);
    }
  }
}

function sanitizeFailureMessage(message: string): string {
  return message
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/(password|authorization|cookie)=([^\s,;]+)/gi, '$1=[redacted]')
    .slice(0, 2000);
}

function allocatePortPair(runId: string, start: number, end: number): number {
  const pairCount = Math.floor((end - start + 1) / 2);
  if (!Number.isInteger(start) || !Number.isInteger(end) || pairCount < 1) {
    throw new Error(`SUT port range ${start}-${end} cannot allocate an HTTP/PostgreSQL port pair`);
  }
  const hash = crypto.createHash('sha256').update(runId).digest().readUInt32BE(0);
  return start + (hash % pairCount) * 2;
}

async function runFunctionalSmoke(sutBaseUrl: string): Promise<void> {
  const requestId = crypto.randomUUID();
  const ready = await fetch(`${sutBaseUrl}/ready`, {
    headers: { 'X-Request-Id': requestId }, signal: AbortSignal.timeout(10_000),
  });
  if (!ready.ok) throw new Error(`Functional smoke readiness failed with HTTP ${ready.status}`);
  const products = await fetch(`${sutBaseUrl}/products?page=1&limit=1`, {
    headers: { 'X-Request-Id': requestId }, signal: AbortSignal.timeout(10_000),
  });
  if (!products.ok) throw new Error(`Functional smoke product list failed with HTTP ${products.status}`);
  const body = await products.json() as { items?: unknown[] };
  if (!Array.isArray(body.items) || body.items.length === 0) throw new Error('Functional smoke returned no products');

  // A missing order replica can be hidden by a healthy gateway and catalog.
  // A lookup for an unknown UUID is mutation-free and must reach the order
  // implementation (404 is expected; any 5xx indicates broken routing).
  const unknownOrder = await fetch(`${sutBaseUrl}/orders/${crypto.randomUUID()}`, {
    headers: { 'X-Request-Id': crypto.randomUUID() }, signal: AbortSignal.timeout(10_000),
  });
  if (unknownOrder.status >= 500) throw new Error(`Functional smoke order routing failed with HTTP ${unknownOrder.status}`);

  const payment = await fetch(`${sutBaseUrl}/payments/mock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
    body: JSON.stringify({ orderId: crypto.randomUUID(), amount: '1.00', mode: 'MOCK_SUCCESS' }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!payment.ok) throw new Error(`Functional smoke payment routing failed with HTTP ${payment.status}`);
}

async function loadWorkloadIds(databaseUrl: string): Promise<{ productIds: string[]; userIds: string[] }> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const [products, users] = await Promise.all([
      client.query<{ id: string }>('SELECT id FROM products WHERE is_active ORDER BY id LIMIT 50'),
      client.query<{ id: string }>("SELECT id FROM users WHERE role = 'customer' ORDER BY id LIMIT 20"),
    ]);
    if (products.rows.length === 0 || users.rows.length === 0) throw new Error('Restored dataset has no workload IDs');
    return { productIds: products.rows.map((row) => row.id), userIds: users.rows.map((row) => row.id) };
  } finally {
    await client.end();
  }
}

function updateParentExperimentStatus(experimentId: string): void {
  const db = getEvaluatorDb();
  const attempts = db.prepare(`SELECT run_number, load_rps, attempt, state FROM experiment_runs
    WHERE experiment_id = ? ORDER BY load_rps, run_number, attempt DESC`).all(experimentId) as Array<{
      run_number: number; load_rps: number; attempt: number; state: string;
    }>;
  const latestBySlot = new Map<string, { state: string }>();
  for (const attempt of attempts) {
    const key = `${attempt.load_rps}:${attempt.run_number}`;
    if (!latestBySlot.has(key)) latestBySlot.set(key, attempt);
  }
  const states = [...latestBySlot.values()];
  const terminal = states.every((run) => ['COMPLETED', 'FAILED', 'CLEANUP_FAILED', 'CANCEL_REQUESTED'].includes(run.state));
  const status = terminal
    ? states.every((run) => run.state === 'COMPLETED') ? 'COMPLETED'
      : states.some((run) => run.state === 'CANCEL_REQUESTED') ? 'CANCEL_REQUESTED' : 'FAILED'
    : 'RUNNING';
  db.prepare('UPDATE experiments SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), experimentId);
}

export async function startWorkerLoop(config: AppConfig, logger: Logger): Promise<void> {
  const workerId = `worker-${process.pid}`;
  const worker = new WorkerLoop(workerId, logger);

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down experiment worker');
    worker.stop();
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  worker.start();

  // Keep process alive
  await new Promise(() => {});
}
