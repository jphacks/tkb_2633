import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHouseholdChoreDefinitions } from '../src/domain/chores/catalog.ts';
import { prepareV2PersonalCopy, v2PersonalCopyDrafts, v2PersonalCopySourceFingerprint, validateV2PersonalCopyReview, validateV2PersonalCopyAgainstSource } from '../src/features/sharing/v2/personal-copy.ts';
import { fixture, seeds, groupId, now, receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
import { sharedRosterDigest, transferSharedOwnership } from '../src/features/sharing/roster.ts';
import { buildV2CommonPlan } from '../src/features/sharing/v2/common-plan.ts';
import { loadSharedFacts, listSharingOutbox, applyReceivedSharedFacts } from '../src/platform/storage/sharing-ledger.ts';
import { createV2PersonalCopyStore } from '../src/platform/storage/sharing-v2-personal-copy.ts';

function input() {
  const chores = createHouseholdChoreDefinitions('local-household'); chores[0].enabled = true;
  const source = { scope: 'personal', ownerUserId: 'owner', householdId: 'local-household', frequencyMode: 'balanced', chores };
  const context = { userId: 'owner', administratorUserId: 'owner', groupId, rosterDigest: 'a'.repeat(64), groupName: '家族', timeZone: 'Asia/Tokyo' };
  let ordinal = 0;
  return { source, context, selected: [chores[0].id], makeId: () => `copy-${++ordinal}` };
}

test('personal copy emits new shared definitions and future configuration without any private history or mappings', async () => {
  const i = input(); const original = structuredClone(i.source);
  i.source.completions = [{ id: 'private-history-sentinel', completedAt: '2020-01-01' }];
  i.source.chores[0].googleTaskId = 'private-google-sentinel'; i.source.chores[0].applianceId = 'private-parent-sentinel';
  i.source.accessToken = 'private-token-sentinel'; i.source.chores[0].lastCompletedDate = '1999-01-01';
  const review = prepareV2PersonalCopy(i.source, i.context, i.selected, 'common', i.makeId, now());
  const drafts = v2PersonalCopyDrafts(review); const text = JSON.stringify(drafts);
  for (const value of ['private-history-sentinel', 'private-google-sentinel', 'private-parent-sentinel', 'private-token-sentinel', '1999-01-01', i.selected[0]]) assert.equal(text.includes(value), false);
  assert.equal(drafts.length, 2); assert.equal(review.anchorDate, '2026-10-27');
  assert.equal(review.records[0].fields.name, original.chores[0].name);
  assert.equal(review.records[0].configuration.intervalDays, original.chores[0].frequencyDaysByMode.balanced);
  assert.equal(i.source.chores[0].id, original.chores[0].id); assert.equal(i.source.chores[0].enabled, true);
});

test('personal copy commits through real v2 receiver authority and outbox while keeping existing histories intact', async () => {
  const family = await fixture(); const d = await family.device(); const i = input();
  try {
    await d.repository.commit(seeds()); i.context.rosterDigest = sharedRosterDigest(family.archive.at(-1));
    const before = await loadSharedFacts(d.database, groupId);
    const review = prepareV2PersonalCopy(i.source, i.context, i.selected, 'eachMember', i.makeId, now());
    const copied = await d.repository.commit(v2PersonalCopyDrafts(review)); assert.equal(copied.length, 2);
    const after = await loadSharedFacts(d.database, groupId);
    for (const fact of before) assert.deepEqual(after.find(row => row.operation.operationId === fact.operation.operationId), fact);
    const plan = buildV2CommonPlan(await d.repository.readState(), { from: '2026-10-27', through: '2026-10-27', asOfDate: '2026-10-27' });
    const round = plan.occurrences.find(row => row.choreId === review.records[0].sharedChoreId);
    assert.equal(round.subjects.length, 2); assert.ok(round.subjects.every(row => !row.completed));
    assert.equal(plan.history.length, 0);
    assert.ok(copied.every(op => op.schemaVersion === 2 && op.authorUserId === 'owner'));
    assert.equal((await listSharingOutbox(d.database, groupId)).length, after.length);
    assert.equal(d.connection.prepare('SELECT COUNT(*) AS n FROM households').get().n, 0);
  } finally { d.connection.close(); }
});

test('personal settings copy is administrator-scoped and never accepts another owner or workspace', () => {
  for (const change of [i => i.source.ownerUserId = 'other', i => i.source.householdId = 'shared-household', i => i.source.scope = 'shared', i => i.context.administratorUserId = 'other']) {
    const i = input(); change(i);
    assert.throws(() => prepareV2PersonalCopy(i.source, i.context, i.selected, 'common', i.makeId, now()), /本人|管理者/u);
  }
  const i = input(); const review = prepareV2PersonalCopy(i.source, i.context, i.selected, 'common', i.makeId, now());
  assert.throws(() => validateV2PersonalCopyReview(review, { ...i.context, groupId: 'other' }), /確認/u);
});

test('personal copy requires an explicit bounded selection and preserves condition-based chores without invented cycles', () => {
  const i = input();
  for (const ids of [[], ['missing'], [...i.selected, ...i.selected], Array.from({ length: 21 }, (_, n) => `missing-${n}`)]) {
    assert.throws(() => prepareV2PersonalCopy(i.source, i.context, ids, 'common', i.makeId, now()));
  }
  i.source.chores[0].requiresCycleSelection = true;
  const review = prepareV2PersonalCopy(i.source, i.context, i.selected, 'common', i.makeId, now());
  assert.equal(review.records[0].configuration, null); assert.equal(review.records[0].fields.enabled, false);
  assert.equal(v2PersonalCopyDrafts(review).length, 1); assert.equal(i.source.chores[0].enabled, true);
});

test('personal copy respects explicit user and maker intervals before the current frequency mode', () => {
  const i = input(); const chore = i.source.chores[0];
  Object.assign(chore, { userIntervalDays: 20, recommendedCycleDays: 30, manufacturerRecommendedIntervalDays: 45 });
  const interval = () => prepareV2PersonalCopy(i.source, i.context, i.selected, 'common', i.makeId, now()).records[0].configuration.intervalDays;
  assert.equal(interval(), 20); delete chore.userIntervalDays; assert.equal(interval(), 30);
  delete chore.recommendedCycleDays; assert.equal(interval(), 45); delete chore.manufacturerRecommendedIntervalDays;
  i.source.frequencyMode = 'relaxed'; assert.equal(interval(), chore.frequencyDaysByMode.relaxed);
});

test('personal copy review snapshots cannot be changed by a later personal edit and fingerprints ignore completion-only changes', () => {
  const i = input(); const fingerprint = v2PersonalCopySourceFingerprint(i.source, i.context, i.selected);
  const review = prepareV2PersonalCopy(i.source, i.context, i.selected, 'common', i.makeId, now());
  i.source.completions = [{ id: 'later-completion' }]; assert.equal(v2PersonalCopySourceFingerprint(i.source, i.context, i.selected), fingerprint);
  i.source.chores[0].instructions.push('確認後の私的な変更');
  assert.notEqual(v2PersonalCopySourceFingerprint(i.source, i.context, i.selected), fingerprint);
  assert.equal(JSON.stringify(review).includes('確認後の私的な変更'), false);
  review.records[0].fields.name = '未確認の書換え'; assert.throws(() => validateV2PersonalCopyReview(review, i.context), /確認/u);
});

test('personal copy confirmation rejects changed settings audience region or date while retaining an unchanged completion-only source', () => {
  const i = input(); const review = prepareV2PersonalCopy(i.source, i.context, i.selected, 'common', i.makeId, now());
  i.source.completions = [{ id: 'private-completion-after-review' }];
  assert.deepEqual(validateV2PersonalCopyAgainstSource(review, i.context, i.source, now()), review);
  assert.throws(() => validateV2PersonalCopyAgainstSource(review, { ...i.context, rosterDigest: 'b'.repeat(64) }, i.source, now()), /参加者/u);
  assert.throws(() => validateV2PersonalCopyAgainstSource(review, { ...i.context, timeZone: 'Pacific/Honolulu' }, i.source, now()), /参加者/u);
  assert.throws(() => validateV2PersonalCopyAgainstSource(review, i.context, i.source, new Date('2026-10-28T01:00:00Z')), /日付/u);
  i.source.chores[0].recommendedCycleDays = 90;
  assert.throws(() => validateV2PersonalCopyAgainstSource(review, i.context, i.source, now()), /個人設定/u);
});

async function stored() {
  const family = await fixture(); const d = await family.device(); await d.repository.commit(seeds()); const i = input();
  let allowed = true;
  const options = { repository: d.repository, userId: 'owner', groupId, makeId: i.makeId, now,
    assertAccess: () => { if (!allowed) throw new Error('workspace changed'); } };
  const store = createV2PersonalCopyStore(options);
  return { ...i, family, d, store, options, close: () => d.connection.close(), deny: () => { allowed = false; },
    facts: () => loadSharedFacts(d.database, groupId), prepare: () => store.prepare(0, i.source, i.selected, 'common') };
}

test('personal copy preparation persists only a private review and confirmation atomically commits it with signed events', async () => {
  const h = await stored();
  try {
    const before = await h.facts(); const review = await h.prepare();
    assert.equal(review.revision, 1); assert.equal(review.status, 'review'); assert.deepEqual(await h.facts(), before);
    assert.equal((await listSharingOutbox(h.d.database, groupId)).length, before.length);
    const result = await h.store.confirm(review.review, h.source); assert.equal(result.status, 'committed'); assert.equal(result.revision, 2);
    assert.equal((await h.facts()).length, before.length + 2);
    assert.deepEqual(await h.store.read(), result);
    const publicText = JSON.stringify(await h.facts()); assert.equal(publicText.includes(h.selected[0]), false);
    assert.equal(publicText.includes('sourceFingerprint'), false); assert.equal(publicText.includes(review.review.id), false);
    const again = await h.store.confirm(review.review, { ...h.source, chores: [] }); assert.deepEqual(again, result);
    assert.equal((await h.facts()).length, before.length + 2);
  } finally { h.close(); }
});

for (const boundary of ['private-receipt', 'signed-operation']) test(`personal copy rolls back its review receipt events and outbox after ${boundary} SQL failure`, async () => {
  const h = await stored(); const run = h.d.database.runAsync;
  try {
    const review = await h.prepare(); const before = await h.facts(); const outbox = await listSharingOutbox(h.d.database, groupId); let injected = false;
    h.d.database.runAsync = async (sql, ...args) => {
      const result = await run(sql, ...args);
      const match = boundary === 'private-receipt' ? sql.includes('INSERT INTO sharing_v2_private_copy_review') && args.includes('committed')
        : sql.includes('INSERT INTO sharing_operations') && args.includes(review.review.records[0].choreOperationId);
      if (!injected && match) { injected = true; throw new Error('copy SQL failure after write'); } return result;
    };
    await assert.rejects(h.store.confirm(review.review, h.source), /copy SQL failure/u); assert.equal(injected, true);
    h.d.database.runAsync = run;
    assert.deepEqual(await h.store.read(), review); assert.deepEqual(await h.facts(), before);
    assert.deepEqual(await listSharingOutbox(h.d.database, groupId), outbox);
    assert.equal((await h.store.confirm(review.review, h.source)).status, 'committed');
  } finally { h.d.database.runAsync = run; h.close(); }
});

test('personal copy recovers an accepted private review after its SQL reply is lost and survives repository reconstruction', async () => {
  const h = await stored(); const original = h.d.repository.readCurrent; let failed = false;
  try {
    h.d.repository.readCurrent = async read => {
      const value = await original(read); if (!failed && value?.status === 'review') { failed = true; throw new Error('review reply lost'); } return value;
    };
    const review = await h.prepare(); assert.equal(failed, true); assert.equal(review.revision, 1);
    h.d.repository.readCurrent = original;
    const restored = createV2PersonalCopyStore(h.options); assert.deepEqual(await restored.read(), review);
    const readBack = await restored.read(); readBack.review.records[0].fields.name = '表示側の変更';
    assert.notEqual((await restored.read()).review.records[0].fields.name, '表示側の変更');
  } finally { h.d.repository.readCurrent = original; h.close(); }
});

test('personal copy a lost commit response and one hundred repeated confirmations cannot create duplicate chores or facts', async () => {
  const h = await stored(); const commit = h.d.repository.commitCurrent; let failed = false;
  try {
    const review = await h.prepare(); const before = (await h.facts()).length;
    h.d.repository.commitCurrent = async build => { const value = await commit(build); if (!failed) { failed = true; throw new Error('copy commit reply lost'); } return value; };
    const accepted = await h.store.confirm(review.review, h.source); assert.equal(accepted.status, 'committed'); assert.equal(failed, true);
    h.d.repository.commitCurrent = commit;
    const replies = await Promise.all(Array.from({ length: 100 }, () => h.store.confirm(review.review, h.source)));
    assert.ok(replies.every(value => value.revision === 2 && value.status === 'committed'));
    assert.equal((await h.facts()).length, before + 2);
    assert.equal((await listSharingOutbox(h.d.database, groupId)).length, before + 2);
  } finally { h.d.repository.commitCurrent = commit; h.close(); }
});

test('personal copy changed private settings and group region block confirmation without discarding the prepared review', async () => {
  const h = await stored();
  try {
    const review = await h.prepare(); const before = await h.facts(); h.source.chores[0].name = '後から編集';
    await assert.rejects(h.store.confirm(review.review, h.source), /個人設定/u);
    assert.deepEqual(await h.store.read(), review); assert.deepEqual(await h.facts(), before);
    h.source.chores[0].name = review.review.records[0].fields.name;
    await h.d.repository.commit([{ operationId: 'changed-copy-zone', entityId: 'settings', entityType: 'settings', operationType: 'patch', payload: { timeZone: 'UTC' } }]);
    const afterZone = await h.facts(); await assert.rejects(h.store.confirm(review.review, h.source), /参加者|地域/u);
    assert.deepEqual(await h.store.read(), review); assert.deepEqual(await h.facts(), afterZone);
  } finally { h.close(); }
});

test('personal copy a handover revokes prepared settings publication while the former administrator keeps their private review', async () => {
  const h = await stored();
  try {
    const review = await h.prepare(); const before = await h.facts();
    h.family.archive.push(transferSharedOwnership(h.family.archive.at(-1), h.family.owner, { userId: 'member', deviceId: h.family.member.deviceId }));
    await assert.rejects(h.store.confirm(review.review, h.source), /参加者|管理者/u);
    assert.deepEqual(await h.store.read(), review); assert.deepEqual(await h.facts(), before);
  } finally { h.close(); }
});

test('personal copy review revisions prevent an old screen from clearing or confirming a different prepared selection', async () => {
  const h = await stored();
  try {
    const first = await h.prepare(); const cleared = await h.store.clear(first.revision); assert.equal(cleared.revision, 2); assert.equal(cleared.review, null);
    await assert.rejects(h.store.prepare(0, h.source, h.selected, 'common'), /別の画面/u);
    const second = await h.store.prepare(2, h.source, h.selected, 'eachMember'); assert.equal(second.revision, 3);
    await assert.rejects(h.store.clear(first.revision), /変わりました/u);
    await assert.rejects(h.store.confirm(first.review, h.source), /確認/u);
    assert.deepEqual(await h.store.read(), second);
    h.deny(); await assert.rejects(h.store.confirm(second.review, h.source), /workspace changed/u);
  } finally { h.close(); }
});

test('personal copy distinguishes a local durable copy from server-acknowledged changes and cannot recreate sent facts', async () => {
  const h = await stored();
  try {
    const review = await h.prepare(); const local = await h.store.confirm(review.review, h.source);
    assert.equal(local.synchronization, 'pending');
    const facts = await h.facts();
    await applyReceivedSharedFacts(h.d.database, groupId, facts, '6', h.d.repository.project, null, now().getTime(),
      h.d.repository.evidenceForServerReceipts(receiptsFor(facts)));
    assert.equal((await h.store.read()).synchronization, 'sent');
    assert.equal((await h.store.confirm(review.review, h.source)).synchronization, 'sent');
    assert.equal((await listSharingOutbox(h.d.database, groupId)).length, 0); assert.deepEqual(await h.facts(), facts);
  } finally { h.close(); }
});

test('personal copy retains a locally saved receipt after permission revocation and exposes its unpublished facts for review', async () => {
  const h = await stored();
  try {
    const review = await h.prepare(); await h.store.confirm(review.review, h.source); const facts = await h.facts();
    h.family.archive.push(transferSharedOwnership(h.family.archive.at(-1), h.family.owner, { userId: 'member', deviceId: h.family.member.deviceId }));
    const retained = await h.store.read(); assert.equal(retained.status, 'committed'); assert.equal(retained.synchronization, 'needsReview');
    assert.equal((await h.store.confirm(review.review, h.source)).synchronization, 'needsReview');
    assert.deepEqual(await h.facts(), facts); assert.equal((await listSharingOutbox(h.d.database, groupId)).length, facts.length);
  } finally { h.close(); }
});
