import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadNativeModule } from './helpers/native-module.mjs';
import * as snapshot from '../src/features/notifications/request-snapshot.ts';
import * as crypto from '../src/features/sharing/crypto.ts';
import { v2NativeWorkspaceNamespace } from '../src/features/sharing/v2/native-identity.ts';

test('Native notification snapshots preserve all JSON values while ignoring dictionary and request ordering', () => {
  const first = [{ identifier: 'b', content: { title: 'B', data: { workspace: 'own', date: '2026-10-29' } }, trigger: null },
    { identifier: 'a', content: { body: 'A', sound: undefined }, trigger: { date: new Date('2026-10-29T12:00:00Z') } }];
  const reordered = [{ trigger: { date: new Date('2026-10-29T12:00:00Z') }, content: { sound: undefined, body: 'A' }, identifier: 'a' },
    { trigger: null, content: { data: { date: '2026-10-29', workspace: 'own' }, title: 'B' }, identifier: 'b' }];
  const before = JSON.stringify(first); assert.equal(snapshot.serializeNotificationRequests(first), snapshot.serializeNotificationRequests(reordered));
  assert.equal(JSON.stringify(first), before); assert.deepEqual(JSON.parse(snapshot.serializeNotificationRequests(first)).map(row => row.identifier), ['a', 'b']);
  reordered[1].content.data.workspace = 'foreign'; assert.notEqual(snapshot.serializeNotificationRequests(first), snapshot.serializeNotificationRequests(reordered));
});

function setup(change) {
  let reads = 0; let delivered = false; const notices = [];
  const module = loadNativeModule('src/platform/sharing/v2-completion-notice-preview.ts', {
    '../../features/sharing/v2/payload-schema': { V2_SCHEDULER_VERSION: 'fixture' }, '../../features/sharing/crypto': crypto,
    '../../features/notifications/request-snapshot': snapshot,
    'expo-notifications': { getPermissionsAsync: async () => ({ granted: true }),
      getPresentedNotificationsAsync: async () => {
        reads++;
        const content = reads % 2 ? { title: 'kept', data: { date: '2026-10-29', workspace: 'personal' } }
          : { data: { workspace: 'personal', date: '2026-10-29' }, title: 'kept' };
        const request = reads % 2 ? { identifier: 'personal', content, trigger: null } : { trigger: null, content, identifier: 'personal' };
        if (delivered && change === 'content') request.content.title = 'changed';
        return [...(delivered && change === 'removed' ? [] : [{ request }]), ...notices];
      }, dismissNotificationAsync: async id => { const index = notices.findIndex(row => row.request.identifier === id); if (index >= 0) notices.splice(index, 1); } },
    './v2-completion-notices': {
      developmentV2CompletionNoticePrefix: scope => `liflow-qa-v2-completed:${v2NativeWorkspaceNamespace(scope.userId, scope.groupId)}:`,
      createV2CompletionNoticePresenter: () => async notice => { delivered = true; notices.push({ request: { identifier: notice.key,
        content: { title: notice.title, body: notice.body, data: { kind: 'v2-housework-completed' } } } }); },
    },
  });
  return { qa: module.createV2CompletionNoticePreview(), notices };
}

test('completion OS QA treats Native dictionary and request ordering changes as unchanged notifications', async () => {
  const previous = globalThis.__DEV__; globalThis.__DEV__ = true;
  try {
    const h = setup(); assert.match(await h.qa.present(), /OS要求 PASS/u); assert.match(await h.qa.inspect(), /OS表示 PASS/u);
    assert.match(await h.qa.clear(), /片付け PASS/u); assert.equal(h.notices.length, 0);
  } finally { if (previous === undefined) delete globalThis.__DEV__; else globalThis.__DEV__ = previous; }
});

test('completion OS QA still rejects a changed or removed non-QA notification', async () => {
  const previous = globalThis.__DEV__; globalThis.__DEV__ = true;
  try { for (const change of ['content', 'removed']) await assert.rejects(setup(change).qa.present(), /他の表示通知/u); }
  finally { if (previous === undefined) delete globalThis.__DEV__; else globalThis.__DEV__ = previous; }
});
