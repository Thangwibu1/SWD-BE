import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createAiContract } from '../src/evaluator/registry/ai-contract.js';

const output = path.resolve(process.argv[2] ?? 'docs/ai-contract');
mkdirSync(output, { recursive: true });
const contract = createAiContract();
writeFileSync(path.join(output, 'prompt.vi.txt'), contract.prompt);
writeFileSync(path.join(output, 'ai-selection.schema.json'), JSON.stringify(contract.selectionSchema, null, 2) + '\n');
writeFileSync(
  path.join(output, 'supported-candidate.schema.json'),
  JSON.stringify(contract.schema, null, 2) + '\n',
);
writeFileSync(
  path.join(output, 'catalog.json'),
  JSON.stringify(contract.candidates, null, 2) + '\n',
);
console.log(`Exported ${contract.supportedArchitectureIds.length} supported profiles to ${output}`);
