import assert from 'node:assert/strict';
import { fixture, seeds, now, groupId, receiptsFor } from './sharing-v2-repository-fixture.mjs';
import { createV2GroupController } from '../../src/features/sharing/v2/controller.ts';
import { loadSharedFacts, applyReceivedSharedFacts } from '../../src/platform/storage/sharing-ledger.ts';
import { chorePolicyFromPreset } from '../../src/features/sharing/v2/model.ts';
import { createDeviceIdentity } from '../../src/features/sharing/crypto.ts';
import { approveSharedDevice } from '../../src/features/sharing/roster.ts';
import { sharingTestCrypto } from './sharing-crypto.mjs';

export const ref = { choreId: 'floor', anchorDate: '2026-10-27', ruleVersion: 1, subjectUserId: null };
export const range = { from: '2026-10-20', through: '2026-11-10', asOfDate: '2026-10-27' };
const day = (date) => ({ precision: 'date', date });
export async function decisionFixture({ fixed = false, secondOwner = false, timeZone = 'Asia/Tokyo', intervalDays = 7, anchorDate = ref.anchorDate } = {}) {
  const f = await fixture(); let extra;
  if (secondOwner) { extra = await createDeviceIdentity(sharingTestCrypto); f.archive.push(approveSharedDevice(f.archive.at(-1), f.owner, 'owner', extra)); }
  const owner = await f.device(); const member = await f.device('member', f.member); const owner2 = extra ? await f.device('owner', extra) : null;
  const controller = (d) => { let id = 0; return createV2GroupController(d.repository, { makeId: () => `${d.options.identity.deviceId}-decision-form-${++id}`, now, sync: async () => {} }); };
  const a = controller(owner); const b = controller(member);
  let cursor = 0;
  const deliver = async (source, destinations = [owner, member]) => {
    const facts = await loadSharedFacts(source.database, groupId);
    for (const d of destinations) await applyReceivedSharedFacts(d.database, groupId, facts, String(++cursor), d.repository.project,
      undefined, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(facts)));
  };
  const initial = seeds(); initial[1].payload.timeZone = timeZone;
  Object.assign(initial[3].payload.configuration, { intervalDays, anchorDate });
  if (fixed) initial[3].payload.configuration.policy = chorePolicyFromPreset('assigned', ['member']);
  await owner.repository.commit(initial);
  const interval = (start, end) => ({ precision: 'interval', start: `2026-10-27T${start}:00.000Z`, end: `2026-10-27T${end}:00.000Z` });
  await a.actions.changeDate(ref, { mode: fixed ? 'fixed' : 'day', target: fixed ? interval('10:00', '10:30') : day('2026-10-30'), options: { strict: true, adminLocked: true } });
  await deliver(owner);
  const [request] = await b.actions.changeDate(ref, { mode: fixed ? 'fixed' : 'day', target: fixed ? interval('11:00', '11:30') : day('2026-10-31') }); await deliver(member);
  assert.equal((await a.readModel(range)).requests[0].kind, 'awaiting');
  if (owner2) await deliver(owner, [owner2]);
  return { ...f, owner, member, owner2, a, b, c: owner2 ? controller(owner2) : null, request, deliver,
    close() { owner.connection.close(); member.connection.close(); owner2?.connection.close(); } };
}
