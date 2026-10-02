import { execa } from 'execa';
import type { Logger } from '../../utils/logger.js';

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
  await execa('docker', [
    'compose',
    '-p', projectName,
    '-f', composeFilePath,
    'config',
    '--quiet'
  ]);

  logger.info({ projectName }, 'Deploying architecture stack');
  
  // Deploy with wait
  await execa('docker', [
    'compose',
    '-p', projectName,
    '-f', composeFilePath,
    'up',
    '-d',
    '--wait'
  ]);
  
  logger.info({ projectName }, 'Architecture stack deployed and ready');
}

export async function cleanupCompose(options: DockerDeployOptions): Promise<void> {
  const { runId, composeFilePath, logger } = options;
  const projectName = `bench-${runId}`;

  logger.info({ projectName }, 'Tearing down architecture stack');
  await execa('docker', [
    'compose',
    '-p', projectName,
    '-f', composeFilePath,
    'down',
    '--volumes',
    '--remove-orphans'
  ], { reject: false });
  
  logger.info({ projectName }, 'Architecture stack cleanup complete');
}

export async function getComposeLogs(options: DockerDeployOptions): Promise<string> {
  const { runId, composeFilePath } = options;
  const projectName = `bench-${runId}`;

  const result = await execa('docker', [
    'compose',
    '-p', projectName,
    '-f', composeFilePath,
    'logs',
    '--no-color'
  ]);
  
  return result.stdout;
}
