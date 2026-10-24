import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectContainerStatsSeries, containerStatsCoverage, type ContainerStatsSample } from '../../src/evaluator/metrics-collector/index.js';
import { createLogger } from '../../src/utils/logger.js';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('execa', () => ({ execa: execute }));
const logger = createLogger('test', 'silent');

describe('resource sampler with Docker CLI latency', () => {
  afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

  it('collects the planned four samples in 20s despite 2.6s snapshot latency', async () => {
    vi.useFakeTimers();
    execute.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'ps') return Promise.resolve({ exitCode: 0, stdout: 'abc' });
      return new Promise(resolve => setTimeout(() => resolve({ exitCode: 0,
        stdout: 'abc\tsut\t1%\t10MiB / 100MiB\t1kB / 2kB' }), 2600));
    });
    const abort = new AbortController();
    const startedAt = new Date();
    const pending = collectContainerStatsSeries('bench-test', abort.signal, logger);
    await vi.advanceTimersByTimeAsync(20_000);
    abort.abort();
    await vi.advanceTimersByTimeAsync(3000);
    const samples = await pending;
    expect(samples).toHaveLength(4);
    expect(samples.every(sample => sample.containers.length === 1)).toBe(true);
    expect(containerStatsCoverage(samples, startedAt, 20)).toBe(100);
  });

  it('cannot fill a missing window with duplicate or late snapshots', () => {
    const start = new Date('2026-10-16T00:00:00Z');
    const samples = [2, 3, 7, 12, 21, 22].map(second => ({
      collectedAt: new Date(start.getTime() + second * 1000).toISOString(),
      containers: [{}],
    })) as ContainerStatsSample[];
    expect(containerStatsCoverage(samples, start, 20)).toBe(75);
  });

  it('does not count an in-flight snapshot completed after the measurement stops', async () => {
    vi.useFakeTimers();
    execute.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'ps') return Promise.resolve({ exitCode: 0, stdout: 'abc' });
      return new Promise(resolve => setTimeout(() => resolve({ exitCode: 0,
        stdout: 'abc\tsut\t1%\t10MiB / 100MiB\t1kB / 2kB' }), 2600));
    });
    const abort = new AbortController();
    const pending = collectContainerStatsSeries('bench-test', abort.signal, logger);
    await vi.advanceTimersByTimeAsync(1000);
    abort.abort();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toHaveLength(0);
  });
});
