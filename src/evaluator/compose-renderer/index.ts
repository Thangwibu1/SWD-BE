import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import type { ArchitectureProfile } from '../registry/index.js';

export interface RenderOptions {
  runId: string;
  profile: ArchitectureProfile;
  databaseUrl: string;
  redisUrl?: string;
  rabbitmqUrl?: string;
  hostPortStart: number;
}

export function renderCompose(options: RenderOptions): { filePath: string; composeContent: string } {
  // Read the whitelisted template
  const templatePath = path.resolve(options.profile.composeTemplate);
  const content = readFileSync(templatePath, 'utf8');
  
  // Parse YAML to manipulate
  const compose = yamlParse(content);
  
  // Update resource limits for each service based on profile
  for (const [serviceName, svc] of Object.entries(compose.services) as [string, any][]) {
    const resourceAlloc = options.profile.resources?.[serviceName];
    if (resourceAlloc) {
      svc.cpus = resourceAlloc.cpus.toString();
      svc.mem_limit = `${resourceAlloc.memoryMiB}m`;
    }
  }

  const renderedContent = yamlStringify(compose);
  
  // Write to a temporary run-specific file
  const resultsDir = path.resolve('results', options.runId, 'input');
  mkdirSync(resultsDir, { recursive: true });
  
  const targetPath = path.join(resultsDir, 'resolved-compose.yaml');
  writeFileSync(targetPath, renderedContent);
  
  return { filePath: targetPath, composeContent: renderedContent };
}
