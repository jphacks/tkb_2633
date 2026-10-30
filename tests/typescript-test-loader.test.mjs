import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

test('the project TypeScript resolver preserves ordinary third-party CommonJS resolution used by Firebase', () => {
  const require = createRequire(import.meta.url);
  assert.equal(typeof require('websocket-driver').client, 'function');
});
