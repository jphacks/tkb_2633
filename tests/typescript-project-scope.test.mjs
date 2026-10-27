import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import ts from 'typescript';

test('typechecking includes the live app and v2 routes while excluding immutable handoff source snapshots', () => {
  const root = fileURLToPath(new URL('../', import.meta.url)); const config = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const project = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.equal(project.errors.length, 0); assert.ok(project.fileNames.includes(resolve(root, 'src/app/group-v2/index.tsx')));
  assert.ok(project.fileNames.includes(resolve(root, 'src/app/(tabs)/index.tsx')));
  assert.equal(project.fileNames.some((file) => file.startsWith(resolve(root, 'artifacts') + '/')), false);
});
