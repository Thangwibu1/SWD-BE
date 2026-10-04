import { execa } from 'execa';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from '../../utils/logger.js';

function dockerBin(): string {
  return process.env['DOCKER_BIN'] ?? 'docker';
}

export interface DockerDeployOptions {
  runId: string;
  composeFilePath: string;
  logger: Logger;
}

export async function deployCompose(options: DockerDeployOptions): Promise<void> {
  const { runId, composeFilePath, logger } = options;
  const projectName = `bench-${runId}`;

  logger.info({ projectName, composeFilePath }, 'Validating compose configuration');
  
  // Validate Compose configuration
  const env = composeEnvironment();
  await execa(dockerBin(), [
    'compose',
    '-p', projectName,
    '-f', composeFilePath,
    'config',
    '--quiet'
  ], { env });

  logger.info({ projectName }, 'Deploying architecture stack');
  
  // Deploy with wait
  await execa(dockerBin(), [
    'compose',
    '-p', projectName,
    '-f', composeFilePath,
    'up',
    '-d',
    '--wait'
  ], { env });
  
  logger.info({ projectName }, 'Architecture stack deployed and ready');
}

export function composeEnvironment(): Record<string, string> {
  const versions = Object.fromEntries(
    readFileSync(path.resolve('versions.env'), 'utf8')
      .split(/\r?\n/)
      .filter((line) => /^[A-Z0-9_]+=/.test(line))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  return { ...versions, ...process.env } as Record<string, string>;
}

export async function cleanupCompose(options: DockerDeployOptions): Promise<void> {
  const { runId, composeFilePath, logger } = options;
  const projectName = `bench-${runId}`;

  logger.info({ projectName }, 'Tearing down architecture stack');
  const result = await execa(dockerBin(), [
    'compose',
    '-p', projectName,
    '-f', composeFilePath,
    'down',
    '--volumes',
    '--remove-orphans'
  ], { reject: false, env: composeEnvironment() });
  if (result.exitCode !== 0) {
    throw new Error(`Compose cleanup failed for ${projectName}: ${result.stderr.slice(0, 2000)}`);
  }
  
  logger.info({ projectName }, 'Architecture stack cleanup complete');
}

export interface ContainerHealthSummary {
  oomKills: number;
  unexpectedCrashes: number;
  containers: Array<{ name: string; running: boolean; exitCode: number; oomKilled: boolean }>;
}

export async function inspectComposeHealth(projectName: string, logger: Logger): Promise<ContainerHealthSummary> {
  const listed = await execa(dockerBin(), ['ps', '-aq', '--filter', `label=com.docker.compose.project=${projectName}`], {
    reject: false,
  });
  const ids = listed.stdout.split(/\r?\n/).filter(Boolean);
  if (listed.exitCode !== 0) throw new Error(`Unable to list containers for ${projectName}: ${listed.stderr}`);
  const containers: ContainerHealthSummary['containers'] = [];
  for (const id of ids) {
    const inspected = await execa(dockerBin(), [
      'inspect', '--format', '{{.Name}}\t{{.State.Running}}\t{{.State.ExitCode}}\t{{.State.OOMKilled}}', id,
    ], { reject: false });
    if (inspected.exitCode !== 0) continue;
    const [rawName = '', rawRunning = 'false', rawExit = '0', rawOom = 'false'] = inspected.stdout.trim().split('\t');
    containers.push({
      name: rawName.replace(/^\//, ''),
      running: rawRunning === 'true',
      exitCode: Number(rawExit),
      oomKilled: rawOom === 'true',
    });
  }
  const summary = {
    oomKills: containers.filter((container) => container.oomKilled).length,
    unexpectedCrashes: containers.filter((container) => !container.running && container.exitCode !== 0).length,
    containers,
  };
  logger.info(summary, 'Compose container health inspected');
  return summary;
}

export async function getComposeLogs(options: DockerDeployOptions): Promise<string> {
  const { runId, composeFilePath } = options;
  const projectName = `bench-${runId}`;

  const result = await execa(dockerBin(), [
    'compose',
    '-p', projectName,
    '-f', composeFilePath,
    'logs',
    '--no-color'
  ], { env: composeEnvironment() });

  const maxLogBytes = 10 * 1024 * 1024;
  const log = Buffer.from(result.stdout, 'utf8');
  if (log.byteLength <= maxLogBytes) return result.stdout;
  return `${log.subarray(0, maxLogBytes).toString('utf8')}\n[truncated at ${maxLogBytes} bytes]\n`;
}

export async function healthCheck(
  sutBaseUrl: string,
  timeoutMs: number,
  logger: Logger
): Promise<void> {
  const startTime = Date.now();
  const healthUrl = `${sutBaseUrl}/ready`;

  logger.info({ healthUrl, timeoutMs }, 'Starting health check');

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        logger.info({ elapsed: Date.now() - startTime }, 'Health check passed');
        return;
      }
      logger.debug({ status: response.status }, 'Health check not ready');
    } catch (err) {
      logger.debug({ err }, 'Health check connection failed');
    }

    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  throw new Error(`Health check timeout after ${timeoutMs}ms`);
}
