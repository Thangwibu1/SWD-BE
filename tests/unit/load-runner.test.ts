import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalK6Runner } from '../../src/evaluator/load-runner/index.js';
import { createTestLogger } from '../helpers/logger.js';

vi.mock('execa', () => ({ execa: vi.fn() }));
import { execa } from 'execa';
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe('measurement semantics', () => {
  it('separates operation throughput, HTTP traffic, primary latency and confirmation evidence', async () => {
    vi.stubEnv('K6_TIMESERIES_MODE', 'summary');
    vi.stubEnv('K6_E2E_POLL_SAMPLE_RATE', '0.01');
    const outputDir = mkdtempSync(path.join(os.tmpdir(), 'load-measurement-'));
    directories.push(outputDir);
    const summary = { metrics: {
      http_req_duration: { 'p(99)': 999 }, operation_latency: { values: { 'p(99)': 42, med: 12 } },
      iterations: { count: 1000, rate: 100 }, http_reqs: { values: { count: 1200, rate: 120 } },
      http_req_failed: { value: 0.1 }, checkout_acceptance_rate: { value: 0.9 },
      checkout_confirmation_samples: { count: 10 }, checkout_sampled_confirmation_rate: { value: 0.8 },
      checkout_sampled_unsettled_rate: { value: 0.1 },
    } };
    vi.mocked(execa).mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[];
      writeFileSync(argv[argv.indexOf('--summary-export') + 1]!, JSON.stringify(summary));
      return Promise.resolve({ exitCode: 0, stderr: '' }) as never;
    });
    const result = await new LocalK6Runner().run({ workloadProfile: 'CHECKOUT_V1', targetRps: 100,
      durationSeconds: 10, warmupSeconds: 0, cooldownSeconds: 0, sutBaseUrl: 'http://localhost:3000',
      productIds: ['p'], userIds: ['u'], outputDir }, createTestLogger());
    expect(result.achievedRps).toBe(100);
    expect(result.achievedHttpRps).toBe(120);
    expect(result.httpReqDuration.p99).toBe(42);
    expect(result.checkoutAcceptanceRate).toBe(0.9);
    expect(result.checkoutSampledConfirmationRate).toBe(0.8);
    expect(result.checkoutConfirmationSamples).toBe(10);
    const settings = JSON.parse(readFileSync(path.join(outputDir, 'load-configuration.json'), 'utf8'));
    expect(settings.e2ePollSampleRate).toBe(0.01);
    expect(settings.timeseries).toBe(false);
  });
});
