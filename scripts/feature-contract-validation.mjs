/** Keep unit regressions mandatory, and independently require Cloud cases to remain in the CI emulator job. */
export function validateFeatureContracts(contracts, { readSource, cloudCommand, ciWorkflow }) {
  if (!Array.isArray(contracts) || !contracts.length) throw new Error('Feature contracts must not be empty');
  const ids = new Set(); let cloudCount = 0;
  function checkReference(check, contract, cloud) {
    const pattern = cloud ? /^tests\/[^/]+\.integration\.mjs$/u : /^tests\/[^/]+\.test\.mjs$/u;
    if (!pattern.test(check.file) || !check.name) throw new Error(`Invalid test reference: ${contract.feature}`);
    if (!readSource(check.file).includes(check.name)) throw new Error(`Required regression test is missing: ${contract.feature} / ${check.name}`);
    if (cloud) {
      if (!cloudCommand?.split(/\s+/u).includes(check.file) || !cloudCommand.split(/\s+/u).includes('--test')) throw new Error(`Cloud regression is not executed: ${check.file}`);
      if (!ciWorkflow?.includes('npm run test:sharing-cloud')) throw new Error('Cloud regression CI job is missing');
      cloudCount++;
    }
  }
  for (const contract of contracts) {
    if (!contract.feature || ids.has(contract.feature) || !Array.isArray(contract.tests) || !contract.tests.length) throw new Error('Invalid or duplicate feature contract');
    ids.add(contract.feature);
    for (const check of contract.tests) checkReference(check, contract, false);
    if (contract.cloudTests !== undefined) {
      if (!Array.isArray(contract.cloudTests) || !contract.cloudTests.length) throw new Error(`Empty Cloud regression contract: ${contract.feature}`);
      for (const check of contract.cloudTests) checkReference(check, contract, true);
    }
  }
  return { features: contracts.length, cloudCount };
}
