import './typescript-loader.mjs';
import assert from 'node:assert/strict';
import { fixture, seeds, groupId, now } from './sharing-v2-repository-fixture.mjs';
import { createV2GoogleTaskStore } from '../../src/platform/storage/sharing-v2-google-tasks.ts';
import { createV2PlannerActions } from '../../src/features/sharing/v2/actions.ts';
import { v2NativeWorkspaceNamespace } from '../../src/features/sharing/v2/native-identity.ts';
const { reconcileGoogleTasks } = await import('../../src/features/google-sync/reconcile-google-tasks.ts');

export async function googleFixture({ seed = seeds(), userId = 'owner', clock = now, shared } = {}) {
  const family = shared ?? await fixture({ clock }); const d = await family.device(userId, userId === 'owner' ? family.owner : family.member);
  if (seed.length) await d.repository.commit(seed);
  let ordinal = 0; const hooks = {}; const calls = []; const tasks = new Map();
  const lists = [{ id: 'unrelated-list', title: '個人の別リスト' }];
  const api = {
    async listTaskLists() { return structuredClone(lists); },
    async createTaskList(_token, title) { const row = { id: 'v2-private-list', title }; lists.push(row); calls.push(['list', title]); return { ...row }; },
    async listTasks(_token, listId) { assert.equal(listId, 'v2-private-list'); await hooks.beforeRead?.(); return structuredClone([...tasks.values()]); },
    async createTask(_token, _list, draft) { const task = { ...draft, id: `google-${++ordinal}`, status: 'needsAction' }; tasks.set(task.id, task); calls.push(['create', task.id]); return structuredClone(task); },
    async createTasksBatch(token, list, drafts) {
      assert.ok(drafts.length <= 100); calls.push(['create-batch', drafts.length]); const result = [];
      for (const draft of drafts) result.push({ ok: true, task: await api.createTask(token, list, draft) });
      await hooks.afterCreate?.(); return result;
    },
    async patchTask(_token, _list, id, patch) { const task = tasks.get(id); assert.ok(task); Object.assign(task, patch); calls.push(['patch', id, structuredClone(patch)]); await hooks.afterPatch?.(id, patch); return structuredClone(task); },
    async patchTasksBatch(token, list, changes) {
      assert.ok(changes.length <= 100); calls.push(['patch-batch', changes.length]); const results = [];
      for (const row of changes) results.push({ ok: true, task: await api.patchTask(token, list, row.taskId, row.patch) }); return results;
    },
    async getTask(_token, _list, id) { assert.ok(tasks.has(id)); return structuredClone(tasks.get(id)); },
    async deleteTask(_token, _list, id) { tasks.get(id).deleted = true; calls.push(['delete', id]); },
  };
  const scope = { repository: d.repository, userId, groupId, assertAccess: () => { if (!access) throw new Error('account changed'); }, makeId: () => `google-action-${++ordinal}`, now: clock };
  let access = true; const store = createV2GoogleTaskStore(scope); const namespace = v2NativeWorkspaceNamespace(userId, groupId);
  const actions = createV2PlannerActions(d.repository, { makeId: () => `local-action-${++ordinal}`, now: clock });
  const connect = () => store.configure(0, { subject: 'synthetic-google-subject', label: '検査用のGoogle' }, true);
  async function sync(port = store.port) {
    const control = await store.readControl(); assert.equal(control.state.enabled, true);
    const result = await reconcileGoogleTasks({ accessToken: 'synthetic-token', state: control.state, repository: port, api, now: clock(), today: '2026-10-27' });
    await store.saveSyncState({ ...control.state, taskListId: result.taskListId, status: 'idle', lastSuccessfulSyncAt: clock().toISOString() }, control.revision); return result;
  }
  return { family, d, scope, store, namespace, api, calls, tasks, lists, hooks, actions, connect, sync,
    entries: () => store.port.listEntriesForGoogleSync('2026-10-27', namespace), links: () => store.port.listGoogleTaskLinks(namespace),
    stop: () => { access = false; }, close: () => d.connection.close() };
}
