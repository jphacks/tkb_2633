import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from './helpers/sqlite.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';
import { sharingTestCrypto } from './helpers/sharing-crypto.mjs';
import * as crypto from '../src/features/sharing/crypto.ts';
import * as roster from '../src/features/sharing/roster.ts';
import * as events from '../src/platform/storage/sharing-v2-events.ts';
import * as ledger from '../src/platform/storage/sharing-ledger.ts';
import * as schema from '../src/features/sharing/v2/payload-schema.ts';
import * as bootstrap from '../src/features/sharing/v2/bootstrap.ts';
import * as model from '../src/features/sharing/v2/model.ts';
import * as controller from '../src/features/sharing/v2/controller.ts';
import * as personal from '../src/features/sharing/v2/personal-plan.ts';
import * as identities from '../src/features/sharing/v2/native-identity.ts';
import * as clock from '../src/features/sharing/group-clock.ts';
import * as dates from '../src/domain/scheduling/local-date.ts';
import * as locking from '../src/features/google-sync/operation-lock.ts';
import * as policy from '../src/features/google-sync/workspace-policy.ts';
import * as projection from '../src/features/sharing/v2/google-tasks-projection.ts';

for (const platform of ['ios', 'android']) test(`${platform} v2 Tasks QA can complete and undo as its first action after reopening without an unprepared Native port or extra Google read`, async () => {
  const previous = globalThis.__DEV__; globalThis.__DEV__ = true;
  const db = createDatabase(); db.database.closeAsync = async () => {};
  const identity = await crypto.createDeviceIdentity(sharingTestCrypto);
  let input; let portReads = 0; let syncs = 0; const tasks = new Map(); let links;
  async function currentItems() {
    const today = clock.sharedLocalDate(new Date(), 'Asia/Tokyo');
    const plan = await controller.createV2GroupController(input.repository, { makeId: randomUUID, now: () => new Date(), sync: async () => {} })
      .actions.readPlan({ from: today, through: dates.addDays(today, 14), asOfDate: today });
    const localized = personal.buildV2PersonalPlan(plan, { viewerUserId: input.userId, now: Date.now(),
      settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 1, normalDailyLimit: 2 } } });
    return projection.v2GoogleTaskItems(plan, input.userId, localized);
  }
  const module = loadNativeModule('src/platform/sharing/v2-google-tasks-preview.ts', {
    'expo-crypto': { randomUUID }, './secure-store': { loadOrCreateSharingDeviceIdentity: async () => identity },
    './database-location': { openSharingV2Database: async () => db.database }, '../../features/sharing/roster': roster,
    '../storage/sharing-v2-events': events, '../storage/sharing-ledger': ledger, '../../features/sharing/v2/payload-schema': schema,
    '../../features/sharing/v2/bootstrap': bootstrap, '../../features/sharing/v2/model': model, '../../features/sharing/v2/controller': controller,
    '../../features/sharing/v2/personal-plan': personal, '../../features/sharing/v2/native-identity': identities,
    '../../features/sharing/group-clock': clock, '../../domain/scheduling/local-date': dates,
    '../../features/google-sync/operation-lock': locking, '../../features/google-sync/workspace-policy': policy,
    '../../features/sharing/v2/google-tasks-projection': projection, '../../features/sharing/crypto': crypto,
    '../google-tasks/google-sign-in-gateway': { getCurrentGoogleSubject: async () => 'test-subject', getGoogleTasksAccessToken: async () => 'test-token' },
    '../google-tasks/google-tasks-api': { createGoogleTasksApi: () => ({ getTask: async (_token, _list, id) => tasks.get(id) }) },
    './v2-google-tasks': { createNativeV2GoogleTasks(value) {
      input = value;
      return { store: { port: {
        listEntriesForGoogleSync: async () => { portReads++; throw new Error('本人の予定を読み直してください。'); },
        listGoogleTaskLinks: async () => { portReads++; throw new Error('本人の予定を読み直してください。'); },
      }, readSavedLinks: async () => links }, readControl: async () => ({ revision: 1, state: { enabled: true, accountSubject: 'test-subject', taskListId: 'test-list' } }),
      synchronize: async () => {
        syncs++; const items = await currentItems();
        for (const item of items) {
          const link = links.find(row => row.scheduleEntryId === item.entry.id); const task = tasks.get(link.googleTaskId);
          tasks.set(task.id, { ...task, status: item.completedAt ? 'completed' : 'needsAction' });
        }
        return { kind: 'success', skipped: false };
      } };
    } },
  });
  let qa;
  try {
    qa = await module.createV2GoogleTasksPreview(); const items = await currentItems(); assert.equal(items.length, 3);
    const namespace = identities.v2NativeWorkspaceNamespace(input.userId, input.groupId);
    links = items.map((item, index) => ({ scheduleEntryId: item.entry.id, googleTaskId: `synthetic-${index}` }));
    for (const link of links) tasks.set(link.googleTaskId, { id: link.googleTaskId, status: 'needsAction', notes: policy.sharedGoogleOccurrenceNote(namespace, link.scheduleEntryId) });
    assert.equal(syncs, 0); assert.match(await qa.localComplete(), /^Tasksアプリ完了検査 PASS/u);
    assert.match(await qa.localUndo(), /^Tasksアプリ取消検査 PASS/u);
    assert.equal(portReads, 0); assert.equal(syncs, 2, 'one requested synchronization per action');
    assert.equal(tasks.size, 3); assert.ok([...tasks.values()].every(task => task.status === 'needsAction'));
    assert.equal(db.connection.prepare('SELECT COUNT(*) AS n FROM households').get().n, 0);
  } finally {
    await qa?.close(); db.connection.close(); if (previous === undefined) delete globalThis.__DEV__; else globalThis.__DEV__ = previous;
  }
});
