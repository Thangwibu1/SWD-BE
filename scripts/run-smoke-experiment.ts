#!/usr/bin/env tsx
import { readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getEvaluatorDb } from '../src/metadata/sqlite.js';
import { WorkerLoop } from '../src/worker/worker-loop.js';
import { createLogger } from '../src/utils/logger.js';

const logger = createLogger('smoke-experiment');
// Prometheus runs in Docker during local smoke, so the temporary SUT ports
// must be reachable through host.docker.internal.
process.env.SUT_BIND_HOST ??= '0.0.0.0';

async function main() {
  const profileId = process.argv[2] || 'A01';
  console.log(`Starting smoke experiment for ${profileId}...`);

  const db = getEvaluatorDb();
  
  // 1. Create candidate
  const candidateId = crypto.randomUUID();
  const candidateJson = JSON.parse(readFileSync(path.resolve(`tests/fixtures/candidate-${profileId}.json`), 'utf8'));
  
  db.prepare(`
    INSERT INTO candidates (id, candidate_id, raw_json, validation_status, architecture_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(candidateId, candidateJson.candidateId, JSON.stringify(candidateJson), 'VALID', profileId);

  // 2. Create experiment
  const experimentId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO experiments (
      id, name, candidate_id, workload_profile, load_levels_json, slo_json,
      cost_catalog_version, repetitions, status, warmup_seconds, measure_seconds, cooldown_seconds
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    experimentId, 
    `Smoke Test ${profileId}`, 
    candidateId, 
    'MIXED_V1', 
    JSON.stringify([25]), 
    JSON.stringify({ p99Ms: 100, errorRateMax: 0.01 }), 
    'research-v1', 
    1,
    'PENDING',
    1,
    5,
    0
  );

  // 3. Create run
  const runId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO experiment_runs (id, experiment_id, run_number, load_rps, state)
    VALUES (?, ?, ?, ?, ?)
  `).run(runId, experimentId, 1, 25, 'PENDING');
  
  console.log(`Created experiment run ${runId}, starting worker...`);
  
  const worker = new WorkerLoop('smoke-worker', logger);
  worker.start();
  
  // Wait for the experiment, including a deterministic infrastructure-invalid
  // retry. Looking only at the first run would stop the worker mid-retry.
  while (true) {
    const experiment = db.prepare('SELECT status FROM experiments WHERE id = ?').get(experimentId) as { status: string } | undefined;
    const run = db.prepare('SELECT state, failure_code, failure_message, lease_owner FROM experiment_runs WHERE experiment_id = ? ORDER BY attempt DESC LIMIT 1').get(experimentId) as { state: string; failure_code: string | null; failure_message: string | null; lease_owner: string | null } | undefined;
    if (!run) {
      console.error('Run not found');
      worker.stop();
      process.exit(1);
    }
    if (experiment && ['COMPLETED', 'FAILED', 'CLEANUP_FAILED', 'CANCEL_REQUESTED'].includes(experiment.status)
      && run.lease_owner === null && run.state !== 'PENDING') {
      if (experiment.status !== 'COMPLETED') {
        console.error('Smoke experiment FAILED:', run.failure_code, run.failure_message);
        worker.stop();
        process.exit(1);
      } else {
        console.log('Smoke experiment COMPLETED successfully! Final state:', run.state);
        worker.stop();
        break;
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

main().catch(err => {
  console.error('Smoke test script failed', err);
  process.exit(1);
});
