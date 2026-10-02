import { execa } from 'execa';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from '../../utils/logger.js';

export interface MetricsSnapshot {
  containerStats: ContainerStats[];
  prometheusMetrics: Record<string, number>;
  applicationMetrics: Record<string, number>;
  collectedAt: string;
}

export interface ContainerStats {
  containerId: string;
  name: string;
  cpuPercent: number;
  memoryUsageMiB: number;
  memoryLimitMiB: number;
  networkRxBytes: number;
  networkTxBytes: number;
}

/**
 * Collect container resource stats via `docker stats --no-stream`.
 */
export async function collectContainerStats(
  projectName: string,
  logger: Logger,
): Promise<ContainerStats[]> {
  try {
    const result = await execa('docker', [
      'stats', '--no-stream',
      '--format', '{{.ID}}\t{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}',
      '--filter', `label=com.docker.compose.project=${projectName}`,
    ], { reject: false, timeout: 15000 });

    if (result.exitCode !== 0) {
      logger.warn({ stderr: result.stderr }, 'docker stats failed');
      return [];
    }

    const stats: ContainerStats[] = [];
    for (const line of result.stdout.split('\n').filter(Boolean)) {
      const parts = line.split('\t');
      if (parts.length < 5) continue;

      const cpuStr = (parts[2] ?? '').replace('%', '').trim();
      const memParts = (parts[3] ?? '').split('/');
      const netParts = (parts[4] ?? '').split('/');

      stats.push({
        containerId: parts[0] ?? '',
        name: parts[1] ?? '',
        cpuPercent: parseFloat(cpuStr) || 0,
        memoryUsageMiB: parseMemory(memParts[0] ?? ''),
        memoryLimitMiB: parseMemory(memParts[1] ?? ''),
        networkRxBytes: parseBytes(netParts[0] ?? ''),
        networkTxBytes: parseBytes(netParts[1] ?? ''),
      });
    }

    return stats;
  } catch (err) {
    logger.error({ err }, 'Failed to collect container stats');
    return [];
  }
}

/**
 * Query Prometheus for SUT metrics during the measurement window.
 */
export async function collectPrometheusMetrics(
  prometheusUrl: string,
  _projectName: string,
  _startTime: Date,
  _endTime: Date,
  logger: Logger,
): Promise<Record<string, number>> {
  const metrics: Record<string, number> = {};

  try {
    // Check if Prometheus is reachable
    const response = await fetch(`${prometheusUrl}/api/v1/status/build`);
    if (!response.ok) {
      logger.warn('Prometheus not reachable, skipping metrics collection');
      return metrics;
    }

    // Query key metrics
    const queries: Record<string, string> = {
      'cpu_usage_seconds': 'sum(rate(container_cpu_usage_seconds_total[1m]))',
      'memory_working_set_bytes': 'sum(container_memory_working_set_bytes)',
      'network_rx_bytes': 'sum(rate(container_network_receive_bytes_total[1m]))',
      'network_tx_bytes': 'sum(rate(container_network_transmit_bytes_total[1m]))',
    };

    for (const [key, query] of Object.entries(queries)) {
      try {
        const qRes = await fetch(`${prometheusUrl}/api/v1/query?query=${encodeURIComponent(query)}`);
        if (qRes.ok) {
          const data = await qRes.json() as { data?: { result?: Array<{ value?: [number, string] }> } };
          const result = data?.data?.result?.[0]?.value?.[1];
          if (result) {
            metrics[key] = parseFloat(result);
          }
        }
      } catch {
        // Individual query failure is non-fatal
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Prometheus metrics collection failed');
  }

  return metrics;
}

/**
 * Save collected metrics to the run's artifact directory.
 */
export function saveMetricsArtifacts(
  outputDir: string,
  containerStats: ContainerStats[],
  prometheusMetrics: Record<string, number>,
  logger: Logger,
): void {
  const rawDir = path.join(outputDir, 'raw');
  if (!existsSync(rawDir)) {
    mkdirSync(rawDir, { recursive: true });
  }

  // Container stats as CSV
  const csvHeader = 'container_id,name,cpu_percent,memory_usage_mib,memory_limit_mib,network_rx_bytes,network_tx_bytes';
  const csvRows = containerStats.map(s =>
    `${s.containerId},${s.name},${s.cpuPercent},${s.memoryUsageMiB},${s.memoryLimitMiB},${s.networkRxBytes},${s.networkTxBytes}`
  );
  writeFileSync(path.join(rawDir, 'container-stats.csv'), [csvHeader, ...csvRows].join('\n'));

  // Prometheus metrics as JSON
  writeFileSync(path.join(rawDir, 'prometheus.json'), JSON.stringify(prometheusMetrics, null, 2));

  logger.info({ containerCount: containerStats.length, metricsCount: Object.keys(prometheusMetrics).length }, 'Metrics artifacts saved');
}

function parseMemory(str: string): number {
  const trimmed = str.trim();
  if (trimmed.endsWith('GiB')) return parseFloat(trimmed) * 1024;
  if (trimmed.endsWith('MiB')) return parseFloat(trimmed);
  if (trimmed.endsWith('KiB')) return parseFloat(trimmed) / 1024;
  if (trimmed.endsWith('B')) return parseFloat(trimmed) / (1024 * 1024);
  return parseFloat(trimmed) || 0;
}

function parseBytes(str: string): number {
  const trimmed = str.trim();
  if (trimmed.endsWith('GB')) return parseFloat(trimmed) * 1e9;
  if (trimmed.endsWith('MB')) return parseFloat(trimmed) * 1e6;
  if (trimmed.endsWith('KB') || trimmed.endsWith('kB')) return parseFloat(trimmed) * 1e3;
  if (trimmed.endsWith('B')) return parseFloat(trimmed);
  return parseFloat(trimmed) || 0;
}
