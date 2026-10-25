import assert from 'node:assert/strict';
import { realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { resolve } = require('metro-resolver');
const directory = fileURLToPath(new URL('../src/platform/widgets/', import.meta.url));

for (const platform of ['ios', 'android']) {
  test(`Metro resolves the ${platform} widget implementation rather than the fallback stub`, () => {
    const result = resolve({
      originModulePath: join(directory, 'expo-widget-gateway.ts'),
      sourceExts: ['js', 'jsx', 'json', 'ts', 'tsx'],
      assetExts: new Set(),
      preferNativePlatform: true,
      getPackageForModule() { return null; },
      fileSystemLookup(path) {
        try { return { exists: true, type: statSync(path).isDirectory() ? 'd' : 'f', realPath: realpathSync(path) }; }
        catch { return { exists: false }; }
      },
    }, './NextChoreWidget', platform);
    assert.equal(dirname(result.filePath), directory.replace(/\/$/, ''));
    assert.ok(result.filePath.endsWith(`NextChoreWidget.${platform}.tsx`));
  });
}
