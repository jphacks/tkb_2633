import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

const { createDailyHouseworkDigestRequests, syncDailyHouseworkDigest } = await import('../src/features/notifications/daily-housework-digest.ts');

const now = new Date(2026, 9, 24, 8);
const entry = {
  id: 'entry', householdId: 'home', choreId: 'one', cycleBaseDate: '2026-10-25',
  windowStart: '2026-10-24', windowEnd: '2026-10-26', suggestedDate: '2026-10-25',
  status: 'inWindow', assignedMemberIds: [],
};
function snapshot(overrides = {}) {
  return {
    scheduleEntries: [entry], chores: [{ id: 'one', name: '掃除' }], completions: [],
    settings: { notificationHour: 9, notificationMinute: 0, notificationsEnabled: true, setupCompleted: true },
    ...overrides,
  };
}
function gateway() {
  const requests = new Map();
  const scheduled = [];
  const cancelled = [];
  return {
    requests, scheduled, cancelled,
    async hasPermission() { return true; },
    async getScheduledRequests() { return [...requests.values()]; },
    async schedule(request) { scheduled.push(request.key); requests.set(request.key, request); return request.key; },
    async cancel(key) { cancelled.push(key); requests.delete(key); },
  };
}

test('only the start, last, and following day notify, and completed chores never notify', () => {
  assert.deepEqual(createDailyHouseworkDigestRequests(snapshot(), now).map((request) => request.data.date), [
    '2026-10-24', '2026-10-26', '2026-10-27',
  ]);
  assert.deepEqual(createDailyHouseworkDigestRequests(snapshot({ completions: [{
    id: 'done', choreId: 'one', outcome: 'completed', completedAt: now.toISOString(), scheduleEntryId: entry.id,
  }] }), now), []);
  assert.deepEqual(createDailyHouseworkDigestRequests(snapshot(), new Date(2026, 9, 28, 8)), []);
});

test('unchanged notifications are retained and only changed or removed requests are touched', async () => {
  const client = gateway();
  await syncDailyHouseworkDigest(client, snapshot(), now);
  assert.equal(client.scheduled.length, 3);
  client.scheduled.length = 0;
  await syncDailyHouseworkDigest(client, snapshot(), now);
  assert.deepEqual(client.scheduled, []);
  assert.deepEqual(client.cancelled, []);
  await syncDailyHouseworkDigest(client, snapshot({ chores: [{ id: 'one', name: '新しい見出し' }] }), now);
  assert.equal(client.scheduled.length, 3);
  const unrelated = { key: 'other-feature', title: 'Other', body: '', fireAt: now.toISOString() };
  client.requests.set(unrelated.key, unrelated);
  await syncDailyHouseworkDigest(client, snapshot({ completions: [{
    id: 'done', choreId: 'one', outcome: 'completed', completedAt: now.toISOString(), scheduleEntryId: entry.id,
  }] }), now);
  assert.equal(client.cancelled.length, 3);
  assert.ok(client.requests.has(unrelated.key));
});

test('disabling notifications cancels this feature only', async () => {
  const client = gateway();
  await syncDailyHouseworkDigest(client, snapshot(), now);
  await syncDailyHouseworkDigest(client, snapshot({ settings: { ...snapshot().settings, notificationsEnabled: false } }), now);
  assert.equal(client.requests.size, 0);
  assert.equal(client.cancelled.length, 3);
});

test('a scheduling failure does not remove all existing reminders', async () => {
  const client = gateway();
  await syncDailyHouseworkDigest(client, snapshot(), now);
  client.schedule = async () => { throw new Error('OS unavailable'); };
  await assert.rejects(syncDailyHouseworkDigest(client, snapshot({ chores: [{ id: 'one', name: '変更' }] }), now), /OS unavailable/);
  assert.equal(client.requests.size, 3);
  assert.deepEqual(client.cancelled, []);
});
