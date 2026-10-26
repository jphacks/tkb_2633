import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { decodeSharingSelection, encodeSharingSelection } from '../src/features/sharing/workspace-selection.ts';

test('shared workspace selection persists only account and group IDs when a screen passes a complete registry record', () => {
  const record = { userId: 'owner', groupId: 'group-test', displayName: 'わが家', status: 'active',
    rosterArchive: [{ body: { ownerUserId: 'owner' } }], lastErrorCode: 'unavailable' };
  const saved = encodeSharingSelection(record);
  assert.deepEqual(JSON.parse(saved), { userId: 'owner', groupId: 'group-test' });
  assert.deepEqual(decodeSharingSelection(saved), { userId: 'owner', groupId: 'group-test' });
  const source = readFileSync(new URL('../src/platform/sharing/workspaces.ts', import.meta.url), 'utf8');
  assert.match(source, /setItem\('active-workspace', encodeSharingSelection\(selection\)\)/);
  assert.match(source, /return decodeSharingSelection\(saved\)/);
});

test('a cold offline restart can read legacy whole-record selections without trusting their stale permissions or error state', () => {
  const legacy = JSON.stringify({ userId: 'owner', groupId: 'group-test', displayName: '旧名称', status: 'active',
    anchor: { untrusted: true }, rosterArchive: [], lastSuccessfulSyncAt: null, lastErrorCode: 'unavailable' });
  assert.deepEqual(decodeSharingSelection(legacy), { userId: 'owner', groupId: 'group-test' });
  assert.equal(encodeSharingSelection(decodeSharingSelection(legacy)), '{"groupId":"group-test","userId":"owner"}');
});

test('invalid saved workspace identities are rejected before any account or database can be opened', () => {
  for (const value of [null, [], 'group-test', {}, { userId: 'owner' }, { userId: '../other', groupId: 'group-test' },
    { userId: 'owner', groupId: 'group/test' }, { userId: 1, groupId: 'group-test' }]) {
    assert.throws(() => decodeSharingSelection(JSON.stringify(value)));
    assert.throws(() => encodeSharingSelection(value));
  }
});
