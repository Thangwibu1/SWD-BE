#!/usr/bin/env tsx
import { readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getEvaluatorDb } from '../src/metadata/sqlite.js';
import { WorkerLoop } from '../src/worker/worker-loop.js';
import { createLogger } from '../src/utils/logger.js';

const logger = createLogger('smoke-experiment');

async function main() {
  const profileId = process.argv[2] || 'A01';
  console.log(`Starting smoke experiment for ${profileId}...`);

  process.env.BACKEND_IMAGE_DIGEST = 'architecture-evaluation-backend:latest';
  process.env.POSTGRES_VERSION = '16-alpine';

  const db = getEvaluatorDb();
  
  // 1. Create candidate
  const candidateId = crypto.randomUUID();
  const candidateJson = JSON.parse(readFileSync(path.resolve(`tests/fixtures/candidate-${profileId}.json`), 'utf8'));
  
  db.prepare(`
    INSERT INTO candidates (id, candidate_id, raw_json, validation_status) 
    VALUES (?, ?, ?, ?)
  `).run(candidateId, candidateJson.candidateId, JSON.stringify(candidateJson), 'VALID');

  // 2. Create experiment
  const experimentId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO experiments (id, name, candidate_id, workload_profile, load_levels_json, slo_json, cost_catalog_version, repetitions, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    experimentId, 
    `Smoke Test ${profileId}`, 
    candidateId, 
    'MIXED_V1', 
    JSON.stringify([25]), 
    JSON.stringify({ p99Ms: 100, errorRateMax: 0.01 }), 
    'research-v1', 
    1, 
    'PENDING'
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
  
  // Wait until completed or failed
  while (true) {
    const run = db.prepare('SELECT state, failure_code, failure_message, lease_owner FROM experiment_runs WHERE id = ?').get(runId) as any;
    if (run.lease_owner === null && run.state !== 'PENDING') {
      if (run.failure_code) {
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
