import assert from 'node:assert/strict';
import test from 'node:test';
import { validateFeatureContracts } from '../scripts/feature-contract-validation.mjs';

const unit = { file: 'tests/kept.test.mjs', name: 'required unit behavior' };
const cloud = { file: 'tests/kept.integration.mjs', name: 'required real Rules behavior' };
const port = { readSource: file => file.endsWith('.test.mjs') ? 'required unit behavior' : 'required real Rules behavior',
  cloudCommand: 'node --test --test-concurrency=1 tests/kept.integration.mjs', ciWorkflow: 'run: firebase emulators:exec "npm run test:sharing-cloud"' };

test('feature contract validation retains strict existing unit references and cannot replace unit checks with Cloud-only coverage', () => {
  assert.deepEqual(validateFeatureContracts([{ feature: 'kept', tests: [unit] }], port), { features: 1, cloudCount: 0 });
  for (const registry of [[], [{ feature: 'missing', tests: [] }], [{ feature: 'missing', cloudTests: [cloud] }],
    [{ feature: 'kept', tests: [cloud] }], [{ feature: 'kept', tests: [{ ...unit, name: 'deleted unit behavior' }] }],
    [{ feature: 'duplicate', tests: [unit] }, { feature: 'duplicate', tests: [unit] }]]) assert.throws(() => validateFeatureContracts(registry, port));
});

test('feature contract validation rejects removal of a required Cloud test, command registration or CI emulator execution', () => {
  const registry = [{ feature: 'cloud-and-unit', tests: [unit], cloudTests: [cloud] }];
  assert.deepEqual(validateFeatureContracts(registry, port), { features: 1, cloudCount: 1 });
  assert.throws(() => validateFeatureContracts(registry, { ...port, readSource: file => file.endsWith('.test.mjs') ? port.readSource(file) : 'deleted Cloud behavior' }), /missing/u);
  assert.throws(() => validateFeatureContracts(registry, { ...port, cloudCommand: 'node --test tests/another.integration.mjs' }), /not executed/u);
  assert.throws(() => validateFeatureContracts(registry, { ...port, cloudCommand: 'echo tests/kept.integration.mjs' }), /not executed/u);
  assert.throws(() => validateFeatureContracts(registry, { ...port, ciWorkflow: 'run: npm test' }), /CI job/u);
  assert.throws(() => validateFeatureContracts([{ ...registry[0], cloudTests: [] }], port), /Empty/u);
  assert.throws(() => validateFeatureContracts([{ ...registry[0], cloudTests: [unit] }], port), /Invalid test reference/u);
});
