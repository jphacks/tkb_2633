import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFeatureContracts } from './feature-contract-validation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const contracts = JSON.parse(readFileSync(resolve(root, 'docs/feature-contracts.json'), 'utf8'));
const checked = validateFeatureContracts(contracts, {
  readSource: file => readFileSync(resolve(root, file), 'utf8'),
  cloudCommand: JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts?.['test:sharing-cloud'],
  ciWorkflow: readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'),
});
console.log(`Required unit regressions are present for ${checked.features} feature contracts. npm test executes them next.`);
if (checked.cloudCount) console.log(`${checked.cloudCount} required Cloud regressions are wired to npm run test:sharing-cloud and its CI emulator job.`);
