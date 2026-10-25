import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const contracts = JSON.parse(readFileSync(resolve(root, 'docs/feature-contracts.json'), 'utf8'));
if (!Array.isArray(contracts) || !contracts.length) throw new Error('Feature contracts must not be empty');
const ids = new Set();
for (const contract of contracts) {
  if (!contract.feature || ids.has(contract.feature) || !contract.tests?.length) throw new Error('Invalid or duplicate feature contract');
  ids.add(contract.feature);
  for (const check of contract.tests) {
    if (!/^tests\/[^/]+\.test\.mjs$/u.test(check.file) || !check.name) throw new Error(`Invalid test reference: ${contract.feature}`);
    const source = readFileSync(resolve(root, check.file), 'utf8');
    if (!source.includes(check.name)) throw new Error(`Required regression test is missing: ${contract.feature} / ${check.name}`);
  }
}
console.log(`Required regression tests are present for ${contracts.length} feature contracts. npm test executes them next.`);
