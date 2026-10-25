import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

test('app configuration supports iOS and Android without a Web entry point', () => {
  const app = JSON.parse(readFileSync(new URL('../app.json', import.meta.url))).expo;
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.deepEqual(app.platforms, ['ios', 'android']);
  assert.equal(app.web, undefined);
  assert.equal(packageJson.scripts.web, undefined);
  assert.equal(packageJson.dependencies['react-dom'], undefined);
  assert.equal(packageJson.dependencies['react-native-web'], undefined);
  const webFiles = readdirSync(new URL('../src/', import.meta.url), { recursive: true }).filter((file) => /\.web\.[jt]sx?$/.test(file));
  assert.deepEqual(webFiles, []);
  assert.equal(app.ios.bundleIdentifier, 'jp.jphacks.tkb2633');
  assert.equal(app.android.package, app.ios.bundleIdentifier);
});
