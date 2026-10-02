#!/usr/bin/env tsx
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateCandidate } from '../src/evaluator/architecture-validator/index.js';

function main() {
  const samplePath = process.argv[2];
  if (!samplePath) {
    console.error('Usage: tsx scripts/validate-candidate.ts <path-to-candidate.json>');
    process.exit(1);
  }

  const json = JSON.parse(readFileSync(path.resolve(samplePath), 'utf8'));
  const result = validateCandidate(json);
  
  if (!result.valid) {
    console.error(`Validation Failed! Code: ${result.code}`);
    for (const err of result.errors) {
      console.error(err);
    }
    process.exit(1);
  }
  
  console.log('Candidate is valid!');
}

main();
