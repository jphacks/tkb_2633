import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { patchHeadlessTimerLease } = require('../scripts/patch-expo-task-manager-headless.cjs');
const native = 'sHeadlessTaskIds; void maybeFinishHeadlessTask() { headlessContext.finishTask(taskId); }';

test('Android background timer lease remains active until the native consumer completes instead of resolving with its placeholder', async () => {
  const source = "AppRegistry.registerHeadlessTask('expo-task-manager', () => async () => {});";
  let provider;
  Function('AppRegistry', patchHeadlessTimerLease(source, native))({ registerHeadlessTask(key, task) {
    assert.equal(key, 'expo-task-manager'); provider = task;
  } });
  let automaticallyFinished = false;
  const placeholder = provider()({});
  placeholder.then(() => { automaticallyFinished = true; });
  await Promise.resolve(); await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(automaticallyFinished, false, 'AppRegistry must not tell JavaTimerManager to pause while real background work is awaiting I/O');
});

test('Expo headless timer compatibility patch is idempotent for TypeScript and compiled registrations and rejects unsupported native lifecycles', () => {
  for (const source of ["AppRegistry.registerHeadlessTask('expo-task-manager', () => async () => {});",
    'AppRegistry.registerHeadlessTask("expo-task-manager", ()=>async ()=>{});']) {
    const patched = patchHeadlessTimerLease(source, native);
    assert.equal(patchHeadlessTimerLease(patched, native), patched);
    assert.throws(() => patchHeadlessTimerLease(source, ''), /native headless timer lease/);
  }
  assert.throws(() => patchHeadlessTimerLease('unknown upstream implementation', native), /Unsupported/);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.postinstall, /patch-expo-task-manager-headless\.cjs/);
  const installed = readFileSync(new URL('../node_modules/expo-task-manager/build/TaskManager.js', import.meta.url), 'utf8');
  assert.match(installed, /liflow-native-timer-lease/, 'the package entry used by Metro must be patched after installation');
});

test('the timer compatibility patch preserves the Android platform guard and never registers its lease on iOS', () => {
  const original = "if (Platform.OS === 'android') { AppRegistry.registerHeadlessTask('expo-task-manager', () => async () => {}); }";
  const source = patchHeadlessTimerLease(original, native);
  for (const platform of ['ios', 'android']) {
    let registrations = 0;
    Function('AppRegistry', 'Platform', source)({ registerHeadlessTask() { registrations++; } }, { OS: platform });
    assert.equal(registrations, platform === 'android' ? 1 : 0);
  }
});
