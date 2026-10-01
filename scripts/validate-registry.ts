#!/usr/bin/env tsx
/**
 * Validates all architecture-registry/*.yaml files against registry.schema.json
 * and checks resource quota constraints (sum(cpus) <= 2.0, sum(memoryMiB) <= 4096).
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parse as yamlParse } from 'yaml';
import { Ajv2020 } from 'ajv/dist/2020.js';

const REGISTRY_DIR = path.resolve('architecture-registry');
const SCHEMA_PATH = path.join(REGISTRY_DIR, 'registry.schema.json');

const MAX_CPUS = 2.0;
const MAX_MEMORY_MIB = 4096;

function main(): void {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as object;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(schema);

  const files = readdirSync(REGISTRY_DIR)
    .filter((f) => /^A\d{2}\.yaml$/.test(f))
    .sort();

  if (files.length === 0) {
    console.log('No registry files found — skipping.');
    process.exit(0);
  }

  let failures = 0;

  for (const file of files) {
    const filePath = path.join(REGISTRY_DIR, file);
    const content = yamlParse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    const valid = validate(content) as boolean;

    if (!valid) {
      console.error(`❌ ${file}: schema validation failed`);
      for (const err of validate.errors ?? []) {
        console.error(`   ${err.instancePath || '/'}: ${err.message}`);
      }
      failures += 1;
      continue;
    }

    // Check ID matches filename.
    if (content.id !== file.replace('.yaml', '')) {
      console.error(`❌ ${file}: id "${String(content.id)}" does not match filename`);
      failures += 1;
      continue;
    }

    // Resource quota check.
    const resources = content.resources as Record<string, { cpus: number; memoryMiB: number }> | undefined;
    if (resources) {
      let totalCpus = 0;
      let totalMemory = 0;
      for (const [, alloc] of Object.entries(resources)) {
        totalCpus += alloc.cpus;
        totalMemory += alloc.memoryMiB;
      }
      if (totalCpus > MAX_CPUS + 0.001) {
        console.error(`❌ ${file}: total CPUs ${totalCpus} exceeds limit ${MAX_CPUS}`);
        failures += 1;
        continue;
      }
      if (totalMemory > MAX_MEMORY_MIB) {
        console.error(`❌ ${file}: total memory ${totalMemory} MiB exceeds limit ${MAX_MEMORY_MIB}`);
        failures += 1;
        continue;
      }
      console.log(`✅ ${file}: valid (${totalCpus} vCPU, ${totalMemory} MiB)`);
    } else {
      console.log(`✅ ${file}: valid (no resource profile)`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} file(s) failed validation.`);
    process.exit(1);
  }

  console.log(`\nAll ${files.length} registry files valid.`);
}

main();
