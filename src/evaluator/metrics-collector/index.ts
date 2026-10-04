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

export interface ContainerStatsSample {
  collectedAt: string;
  containers: ContainerStats[];
}

export function configurePrometheusSutTarget(hostPort: number, host = 'host.docker.internal'): void {
  if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) throw new Error(`Invalid Prometheus SUT port ${hostPort}`);
  if (!/^[A-Za-z0-9.-]+$/.test(host)) throw new Error(`Invalid Prometheus SUT host ${host}`);
  const targetFile = path.resolve('infra/observation/sut-targets.json');
  writeFileSync(targetFile, JSON.stringify([{ targets: [`${host}:${hostPort}`], labels: { job: 'sut-services' } }], null, 2));
}

export async function collectContainerStatsSeries(
  projectName: string,
  signal: AbortSignal,
  logger: Logger,
  intervalMs = 2000,
): Promise<ContainerStatsSample[]> {
  const samples: ContainerStatsSample[] = [];
  while (!signal.aborted) {
    const iterationStartedAt = Date.now();
    const containers = await collectContainerStats(projectName, logger);
    if (containers.length > 0) samples.push({ collectedAt: new Date().toISOString(), containers });
    const waitMs = Math.max(0, intervalMs - (Date.now() - iterationStartedAt));
    if (signal.aborted || waitMs === 0) continue;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      signal.addEventListener('abort', finish, { once: true });
    });
  }
  return samples;
}

export async function collectApplicationMetrics(
  sutBaseUrl: string,
  logger: Logger,
  projectName?: string,
): Promise<string> {
  if (projectName) {
    try {
      const listed = await execa('docker', [
        'ps', '-q', '--filter', `label=com.docker.compose.project=${projectName}`,
      ], { reject: false, timeout: 15000 });
      const sections: string[] = [];
      for (const containerId of listed.stdout.split(/\r?\n/).filter(Boolean)) {
        const role = await execa('docker', [
          'inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', containerId,
        ], { reject: false, timeout: 5000 });
        if (role.stdout.split(/\r?\n/).some((line) => line.startsWith('APP_ROLE='))) {
          const response = await execa('docker', [
            'exec', containerId, 'node', '-e',
            "fetch('http://127.0.0.1:3000/metrics').then(async r=>{if(!r.ok)process.exit(2);process.stdout.write(await r.text())}).catch(()=>process.exit(3))",
          ], { reject: false, timeout: 10000 });
          if (response.exitCode === 0 && response.stdout.trim()) sections.push(response.stdout);
          continue;
        }
        const service = await execa('docker', ['inspect', '--format', '{{index .Config.Labels "com.docker.compose.service"}}', containerId], { reject: false, timeout: 5000 });
        const dependency = await collectDependencyMetrics(containerId, service.stdout.trim());
        if (dependency) sections.push(dependency);
      }
      if (sections.length > 0) return sections.join('\n');
    } catch (err) {
      logger.warn({ err, projectName }, 'Per-service application metrics collection failed');
    }
  }
  try {
    const response = await fetch(`${sutBaseUrl}/metrics`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (err) {
    logger.warn({ err }, 'Application metrics collection failed');
    return '';
  }
}

/**
 * Collect container resource stats via `docker stats --no-stream`.
 */
export async function collectContainerStats(
  projectName: string,
  logger: Logger,
): Promise<ContainerStats[]> {
  try {
    const listed = await execa('docker', [
      'ps', '-q', '--filter', `label=com.docker.compose.project=${projectName}`,
    ], { reject: false, timeout: 15000 });
    const containerIds = listed.stdout.split(/\r?\n/).filter(Boolean);
    if (listed.exitCode !== 0 || containerIds.length === 0) return [];
    const result = await execa('docker', [
      'stats', '--no-stream',
      '--format', '{{.ID}}\t{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}',
      ...containerIds,
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
  projectName: string,
  startTime: Date,
  endTime: Date,
  logger: Logger,
): Promise<Record<string, number>> {
  const metrics: Record<string, number> = {};

  try {
    // Check if Prometheus is reachable
    const response = await fetch(`${prometheusUrl}/-/ready`);
    if (!response.ok) {
      logger.warn('Prometheus not reachable, skipping metrics collection');
      return metrics;
    }

    // Query key metrics
    const queries: Record<string, string> = {
      'http_requests_total': 'sum(http_server_requests_total{job="sut-services"})',
      'http_request_duration_p99_seconds': 'histogram_quantile(0.99, sum by (le) (rate(http_server_request_duration_seconds_bucket{job="sut-services"}[10s])))',
      'cpu_usage_seconds': `sum(rate(container_cpu_usage_seconds_total{container_label_com_docker_compose_project="${projectName}"}[1m]))`,
      'memory_working_set_bytes': `sum(container_memory_working_set_bytes{container_label_com_docker_compose_project="${projectName}"})`,
      'network_rx_bytes': `sum(rate(container_network_receive_bytes_total{container_label_com_docker_compose_project="${projectName}"}[1m]))`,
      'network_tx_bytes': `sum(rate(container_network_transmit_bytes_total{container_label_com_docker_compose_project="${projectName}"}[1m]))`,
      'cpu_throttled_seconds': `sum(rate(container_cpu_cfs_throttled_seconds_total{container_label_com_docker_compose_project="${projectName}"}[1m]))`,
      'disk_read_bytes': `sum(rate(container_fs_reads_bytes_total{container_label_com_docker_compose_project="${projectName}"}[1m]))`,
      'disk_write_bytes': `sum(rate(container_fs_writes_bytes_total{container_label_com_docker_compose_project="${projectName}"}[1m]))`,
    };

    for (const [key, query] of Object.entries(queries)) {
      try {
        const params = new URLSearchParams({
          query,
          start: String(startTime.getTime() / 1000),
          end: String(endTime.getTime() / 1000),
          step: '2',
        });
        const qRes = await fetch(`${prometheusUrl}/api/v1/query_range?${params}`);
        if (qRes.ok) {
          const data = await qRes.json() as { data?: { result?: Array<{ values?: Array<[number, string]> }> } };
          const values = data?.data?.result?.flatMap((series) => series.values ?? []).map((value) => Number(value[1])).filter(Number.isFinite) ?? [];
          if (values.length > 0) {
            metrics[key] = Math.max(...values);
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

async function collectDependencyMetrics(containerId: string, service: string): Promise<string> {
  if (service === 'postgres') {
    const result = await execa('docker', ['exec', containerId, 'psql', '-U', 'bench', '-d', 'ecommerce', '-At', '-F', ',', '-c',
      'SELECT numbackends,xact_commit,xact_rollback,blks_hit,blks_read FROM pg_stat_database WHERE datname=current_database()'], { reject: false, timeout: 10000 });
    if (result.exitCode === 0) {
      const [connections='0', commits='0', rollbacks='0', hits='0', reads='0'] = result.stdout.trim().split(',');
      return `postgres_connections ${connections}\npostgres_commits_total ${commits}\npostgres_rollbacks_total ${rollbacks}\npostgres_buffer_hits_total ${hits}\npostgres_buffer_reads_total ${reads}`;
    }
  }
  if (service === 'redis') {
    const result = await execa('docker', ['exec', containerId, 'redis-cli', 'INFO', 'stats'], { reject: false, timeout: 10000 });
    const memory = await execa('docker', ['exec', containerId, 'redis-cli', 'INFO', 'memory'], { reject: false, timeout: 10000 });
    if (result.exitCode === 0) {
      const values = new Map([...result.stdout.split(/\r?\n/), ...memory.stdout.split(/\r?\n/)].map((line) => line.split(':', 2) as [string, string]));
      return `redis_keyspace_hits_total ${values.get('keyspace_hits') ?? 0}\nredis_keyspace_misses_total ${values.get('keyspace_misses') ?? 0}\nredis_evicted_keys_total ${values.get('evicted_keys') ?? 0}\nredis_memory_bytes ${values.get('used_memory') ?? 0}`;
    }
  }
  if (service === 'rabbitmq') {
    const result = await execa('docker', ['exec', containerId, 'rabbitmqctl', 'list_queues', '--quiet', 'messages', 'messages_unacknowledged'], { reject: false, timeout: 15000 });
    if (result.exitCode === 0) {
      let queued = 0; let unacked = 0;
      for (const line of result.stdout.split(/\r?\n/)) { const [ready, pending] = line.trim().split(/\s+/).map(Number); queued += ready || 0; unacked += pending || 0; }
      return `rabbitmq_queue_messages ${queued}\nrabbitmq_unacked_messages ${unacked}`;
    }
  }
  return '';
}

/**
 * Save collected metrics to the run's artifact directory.
 */
export function saveMetricsArtifacts(
  outputDir: string,
  containerStats: ContainerStatsSample[],
  prometheusMetrics: Record<string, number>,
  applicationMetrics: string,
  logger: Logger,
): void {
  const rawDir = path.join(outputDir, 'raw');
  if (!existsSync(rawDir)) {
    mkdirSync(rawDir, { recursive: true });
  }

  // Container stats as CSV
  const csvHeader = 'collected_at,container_id,name,cpu_percent,memory_usage_mib,memory_limit_mib,network_rx_bytes,network_tx_bytes';
  const csvRows = containerStats.flatMap((sample) => sample.containers.map((s) =>
    `${sample.collectedAt},${s.containerId},${s.name},${s.cpuPercent},${s.memoryUsageMiB},${s.memoryLimitMiB},${s.networkRxBytes},${s.networkTxBytes}`
  ));
  writeFileSync(path.join(rawDir, 'container-stats.csv'), [csvHeader, ...csvRows].join('\n'));

  // Prometheus metrics as JSON
  writeFileSync(path.join(rawDir, 'prometheus.json'), JSON.stringify(prometheusMetrics, null, 2));
  writeFileSync(path.join(rawDir, 'application-metrics.prom'), applicationMetrics);

  logger.info({ sampleCount: containerStats.length, metricsCount: Object.keys(prometheusMetrics).length }, 'Metrics artifacts saved');
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
