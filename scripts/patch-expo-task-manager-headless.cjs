const fs = require('node:fs');
const path = require('node:path');

const marker = 'liflow-native-timer-lease';

function patchHeadlessTimerLease(source, nativeSource) {
  if (!nativeSource.includes('maybeFinishHeadlessTask') || !nativeSource.includes('headlessContext.finishTask(taskId)')
    || !nativeSource.includes('sHeadlessTaskIds')) {
    throw new Error('Expo TaskManager must own and finish its native headless timer lease');
  }
  if (source.includes(marker)) return source;
  const registration = /AppRegistry\.registerHeadlessTask\(\s*(['"])expo-task-manager\1\s*,\s*\(\s*\)\s*=>\s*async\s*\(\s*\)\s*=>\s*\{\s*\}\s*\);/gu;
  if ([...source.matchAll(registration)].length !== 1) throw new Error('Unsupported Expo TaskManager headless registration; review the compatibility patch');
  return source.replace(registration, `// ${marker}: TaskService releases this lease after all real task callbacks finish.
    // Resolving the placeholder here would make AppRegistry pause Android timers early.
    AppRegistry.registerHeadlessTask('expo-task-manager', () => () => new Promise(() => {}));`);
}

module.exports = { patchHeadlessTimerLease };

if (require.main === module) {
  const base = path.join(__dirname, '../node_modules/expo-task-manager');
  const version = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8')).version;
  if (!version.startsWith('58.')) throw new Error('Review the headless timer compatibility patch when upgrading Expo TaskManager');
  const nativeSource = fs.readFileSync(path.join(base, 'android/src/main/java/expo/modules/taskmanager/TaskService.java'), 'utf8');
  const changes = ['src/TaskManager.ts', 'build/TaskManager.js'].map((file) => {
    const target = path.join(base, file); const source = fs.readFileSync(target, 'utf8');
    return { target, source, patched: patchHeadlessTimerLease(source, nativeSource) };
  });
  for (const change of changes) if (change.source !== change.patched) fs.writeFileSync(change.target, change.patched);
  console.log('Configured Expo TaskManager to retain Android timers until native task completion.');
}
