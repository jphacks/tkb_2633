import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, groupId } from './helpers/sharing-v2-repository-fixture.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createV2Synchronizer } from '../src/features/sharing/v2/synchronizer.ts';
import { createSharedGroupManager } from '../src/features/sharing/group-manager.ts';
import { createSharedRoster } from '../src/features/sharing/roster.ts';

async function session({ switchDuringRead = false } = {}) {
  const f = await fixture(); const d = await f.device(); let active = true; let saves = 0; let invitations = 0;
  const dependencies = { groupId, userId: 'owner', database: d.database, identity: f.owner, crypto,
    cloud: { readRoster: async (_id, revision) => f.archive[revision - 1], readGroup: async () => ({ roster: f.archive.at(-1), group: { rotationRequired: false } }),
      createInvitation: async () => { invitations++; } },
    readRecord: async () => { if (switchDuringRead) active = false; return { groupId, userId: 'owner', status: 'active', anchor: f.archive[0], rosterArchive: f.archive }; },
    saveArchive: async () => { saves++; },
    readKey: async () => { throw new Error('Membership validation must not read a group secret'); },
    saveKey: async () => { throw new Error('Membership validation must not create a group secret'); },
    changed: () => {}, serialized: async (work) => work(), assertCurrentAccount: () => { if (!active) throw new Error('account changed'); } };
  return { f, d, dependencies, synchronizer: createV2Synchronizer({ ...dependencies, repository: d.repository }),
    saved: () => saves, invited: () => invitations, close: () => d.connection.close() };
}
test('v2 membership sessions expose the same pinned protocol verification without projecting data or reading keys', async () => {
  const f = await session();
  try {
    assert.deepEqual(await f.synchronizer.verifyMembership(f.f.archive.at(-1)), f.f.archive); assert.equal(f.saved(), 1);
    assert.equal(f.d.connection.prepare('SELECT COUNT(*) AS n FROM sharing_operations').get().n, 0);
    assert.equal(f.d.connection.prepare('SELECT COUNT(*) AS n FROM sharing_v2_projection').get().n, 0);
  } finally { f.close(); }
});
test('v2 membership verification refuses an account switch during its read before saving any archive', async () => {
  const f = await session({ switchDuringRead: true });
  try { await assert.rejects(f.synchronizer.verifyMembership(f.f.archive.at(-1)), /account changed/u); assert.equal(f.saved(), 0); }
  finally { f.close(); }
});
test('v2 membership verification rejects a foreign signed group and the legacy manager still refuses schema2 by default', async () => {
  const f = await session();
  try {
    await assert.rejects(f.synchronizer.verifyMembership(createSharedRoster('foreign-group', 'owner', f.f.owner, { schemaVersion: 2 }))); assert.equal(f.saved(), 0);
    const manager = createSharedGroupManager({ ...f.dependencies, project: f.d.repository.project,
      sync: async () => ({ sent: 0, received: 0, pending: 0, waitingForApproval: false, complete: true }), makeId: () => 'forbidden-invite', markLeft: async () => {} });
    await assert.rejects(manager.createInvitation(), { code: 'sharing/scheduler-version-mismatch' }); assert.equal(f.saved(), 0); assert.equal(f.invited(), 0);
  } finally { f.close(); }
});
