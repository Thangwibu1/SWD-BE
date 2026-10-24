import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createAiContract } from '../../src/evaluator/registry/ai-contract.js';

it('runs native provider adapters, resumes without duplicate calls, and exports failed benchmark attempts', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'swd-ai-batch-'));
  const configPath = path.join(root, 'study.json');
  const out = path.join(root, 'output');
  const contract = createAiContract();
  const candidate = JSON.stringify(contract.candidates[0]);
  const idempotencyKeys = new Set<string>();
  let providerCalls = 0;
  let publishedSnapshots = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v1/architectures/ai-contract')
      return void res.end(JSON.stringify(contract));
    if (req.url === '/api/v1/experiments' && req.method === 'POST') {
      expect(body.candidate.architectureId).toBe('A01');
      idempotencyKeys.add(String(req.headers['idempotency-key']));
      return void res.end(JSON.stringify({ experimentId: `exp-${idempotencyKeys.size}` }));
    }
    if (req.url?.startsWith('/api/v1/ai-batch/studies/') && req.method === 'POST') {
      expect(body.summary.studyId).toBe('mock-integration');
      expect(Array.isArray(body.comparison)).toBe(true);
      publishedSnapshots++;
      return void res.end(JSON.stringify({ published: true }));
    }
    if (req.url?.startsWith('/api/v1/experiments/'))
      return void res.end(
        JSON.stringify({
          id: req.url.split('/').at(-1),
          status: 'FAILED',
          runs: [
            {
              id: 'run-1',
              load_rps: 20,
              run_number: 1,
              attempt: 0,
              state: 'FAILED',
              failure_code: 'LOAD_RUNNER_FAILED',
              metrics_json: null,
            },
            {
              id: 'run-2',
              load_rps: 20,
              run_number: 1,
              attempt: 1,
              state: 'COMPLETED',
              metrics_json: { p99Ms: 42 },
            },
          ],
        }),
      );
    providerCalls++;
    if (req.url === '/v1/chat/completions') {
      expect(req.headers.authorization).toBe('Bearer fake');
      return void res.end(
        JSON.stringify({
          model: 'openai-snapshot',
          choices: [{ finish_reason: 'stop', message: { content: candidate } }],
          usage: { total_tokens: 100 },
        }),
      );
    }
    if (req.url === '/v1/messages') {
      expect(req.headers['x-api-key']).toBe('fake');
      return void res.end(
        JSON.stringify({
          model: 'claude-snapshot',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: candidate }],
        }),
      );
    }
    expect(req.headers['x-goog-api-key']).toBe('fake');
    res.end(
      JSON.stringify({
        modelVersion: 'gemini-snapshot',
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: candidate }] } }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server address');
  const origin = `http://127.0.0.1:${address.port}`;
  const config = JSON.parse(readFileSync('experiments/ai-batch/study.json', 'utf8'));
  config.studyId = 'mock-integration';
  config.generationRepetitions = 1;
  config.intervalMs = 0;
  config.scenarios = [config.scenarios[0]];
  for (const model of config.models) {
    model.baseUrl = `${origin}/v1`;
    model.apiKeyEnv = 'BATCH_TEST_KEY';
  }
  writeFileSync(configPath, JSON.stringify(config));
  const run = (mode: string) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          'scripts/ai-batch.ts',
          mode,
          '--config',
          configPath,
          '--out',
          out,
          '--limit',
          '10',
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, BATCH_TEST_KEY: 'fake', EVALUATOR_API_URL: origin },
        },
      );
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve(output) : reject(new Error(output))));
    });
  try {
    await run('prepare');
    await run('probe');
    expect(providerCalls).toBe(6);
    for (const model of config.models) {
      const probe = JSON.parse(readFileSync(path.join(out, 'probes', `${model.id}.json`), 'utf8'));
      expect(probe.passed).toBe(true);
    }
    await run('generate');
    expect(providerCalls).toBe(12);
    await run('generate');
    expect(providerCalls).toBe(12);
    await run('submit');
    await run('submit');
    expect(idempotencyKeys.size).toBe(6);
    await run('collect');
    expect(publishedSnapshots).toBe(1);
    const summary = JSON.parse(readFileSync(path.join(out, 'summary.json'), 'utf8'));
    expect(summary.recordedGenerations).toBe(6);
    expect(summary.collectedRuns).toBe(12);
    expect(readFileSync(path.join(out, 'runs.csv'), 'utf8')).toContain('LOAD_RUNNER_FAILED');
    const resultsCsv = readFileSync(path.join(out, 'results.csv'), 'utf8');
    expect(resultsCsv).toContain('"architectureId"');
    expect(resultsCsv).toContain('"p99Ms"');
    expect(resultsCsv).toContain('"infraMonthUsd"');
    expect(resultsCsv).toContain('"A01"');
    expect(resultsCsv).toContain('"42"');
    expect(resultsCsv).not.toContain('"LOAD_RUNNER_FAILED"');
    expect(resultsCsv.trim().split('\n')).toHaveLength(7);
    const comparisonCsv = readFileSync(path.join(out, 'comparison.csv'), 'utf8');
    expect(comparisonCsv).toContain('"p99MsMedian"');
    expect(comparisonCsv).toContain('"gatePassRate"');
    expect(comparisonCsv).toContain('"42"');
    for (const name of readdirSync(path.join(out, 'generations'))) {
      expect(JSON.parse(readFileSync(path.join(out, 'generations', name), 'utf8')).status).toBe(
        'VALID',
      );
    }
    config.benchmark.measureSeconds++;
    writeFileSync(configPath, JSON.stringify(config));
    await expect(run('prepare')).rejects.toThrow('Study or registry changed');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(root));
    if (
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      relative.startsWith('swd-ai-batch-')
    )
      rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
