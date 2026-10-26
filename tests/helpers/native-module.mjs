import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

export function loadNativeModule(filename, mocks) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(`../../${filename}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  Function('require', 'module', 'exports', outputText)((name) => {
    assert.ok(name in mocks, `unmocked native import ${name}`); return mocks[name];
  }, module, module.exports);
  return module.exports;
}
