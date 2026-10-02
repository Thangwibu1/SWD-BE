import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parse as yamlParse } from 'yaml';

const REGISTRY_DIR = path.resolve('architecture-registry');

export interface ResourceAllocation {
  cpus: number;
  memoryMiB: number;
}

export interface ArchitectureProfile {
  id: string;
  family: string;
  composeTemplate: string;
  cache: {
    enabled: boolean;
    targets?: string[];
  };
  messaging: {
    enabled: boolean;
    broker: string;
  };
  scalingProfile: string;
  communication: string;
  resourceProfile: string;
  allowedRoles: string[];
  resources?: Record<string, ResourceAllocation>;
}

let registryCache: Map<string, ArchitectureProfile> | null = null;

export function loadRegistry(): Map<string, ArchitectureProfile> {
  if (registryCache) return registryCache;
  
  const registry = new Map<string, ArchitectureProfile>();
  const files = readdirSync(REGISTRY_DIR).filter(f => /^A\d{2}\.yaml$/.test(f));
  
  for (const file of files) {
    const content = readFileSync(path.join(REGISTRY_DIR, file), 'utf8');
    const profile = yamlParse(content) as ArchitectureProfile;
    registry.set(profile.id, profile);
  }
  
  registryCache = registry;
  return registry;
}
