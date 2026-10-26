import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const contractPath = 'src/features/sharing/scheduler-contract.json';
export function sharedSchedulerSourceDigest(files, read = (file) => readFileSync(resolve(root, file))) {
  const digest = createHash('sha256');
  for (const file of files) {
    if ((!file.startsWith('src/') && file !== 'node_modules/moment-timezone/data/packed/latest.json') || file.includes('..')) throw new Error('Invalid scheduler source path');
    digest.update(file); digest.update('\0'); digest.update(read(file)); digest.update('\0');
  }
  return digest.digest('hex');
}
export function assertSharedSchedulerVersion(current, previous) {
  if (!/^liflow-shared-\d+$/u.test(current.version) || !/^[a-f0-9]{64}$/u.test(current.sourceSha256)) throw new Error('Invalid shared scheduler contract');
  if (previous && current.version === previous.version && (current.sourceSha256 !== previous.sourceSha256 || current.timeZoneVersion !== previous.timeZoneVersion)) {
    throw new Error('Shared scheduling or tzdb changed without a shared scheduler version change. Verify cross-platform compatibility and plan the group upgrade first.');
  }
}
export function verifySharedSchedulerContract() {
  const current = JSON.parse(readFileSync(resolve(root, contractPath), 'utf8'));
  assertSharedSchedulerVersion(current);
  const source = readFileSync(resolve(root, 'src/features/sharing/operations.ts'), 'utf8');
  if (!source.includes(`export const SHARED_SCHEDULER_VERSION = '${current.version}';`)) throw new Error('Shared scheduler version differs from its contract');
  if (sharedSchedulerSourceDigest(current.sourceFiles) !== current.sourceSha256) throw new Error('Shared scheduler source changed. Verify the version and update its compatibility contract.');
  const zone = JSON.parse(readFileSync(resolve(root, 'node_modules/moment-timezone/data/packed/latest.json'), 'utf8'));
  if (zone.version !== current.timeZoneVersion) throw new Error('Shared timezone database changed without updating the contract');
  let base = 'origin/main';
  if (process.env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const sha = event.pull_request?.base?.sha ?? event.before;
    if (typeof sha === 'string' && /^[a-f0-9]{40}$/u.test(sha) && !/^0+$/u.test(sha)) base = sha;
  }
  let previous;
  try { previous = JSON.parse(execFileSync('git', ['show', `${base}:${contractPath}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); }
  catch { /* The first sharing release has no prior contract. */ }
  assertSharedSchedulerVersion(current, previous);
  return current;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const current = verifySharedSchedulerContract(); process.stdout.write(`Shared scheduler ${current.version} / tzdb ${current.timeZoneVersion}: PASS\n`);
}
