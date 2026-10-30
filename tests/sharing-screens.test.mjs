import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';
import { notificationWorkspace, isPlannerNotification } from '../src/features/notifications/workspace-response.ts';
import { sharedGoogleNamespace } from '../src/features/google-sync/workspace-policy.ts';

async function chooseFamily(screen) {
  const choice = screen.nodes().find(node => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === '家族');
  assert.ok(choice); choice.props.onPress(); await screen.flush();
}

test('sharing screen preserves anonymous personal mode, explicit Google login, collapsed creation and separate group switching', async () => {
  const calls = []; const group = { userId: 'owner', groupId: 'group-test', displayName: '家族', status: 'active' };
  const context = { active: null, userId: null, groups: [], ready: true, refreshSharing: async () => {},
    switchTo: async (selection) => { calls.push(['switch', selection]); context.active = selection; } };
  const screen = screenHarness('src/app/sharing/index.tsx', { navigate: (...args) => calls.push(['navigate', ...args]), mocks: {
    '@/hooks/use-workspace': { useWorkspace: () => context },
    '@/platform/sharing/firebase-services': { isSharingConfigured: () => true },
    '@/platform/sharing/auth': { isSharingAppleSignInAvailable: async () => false,
      signInSharingWithGoogle: async () => { calls.push(['google']); context.userId = 'owner'; }, signOutSharing: async () => { calls.push(['logout']); context.userId = null; } },
    '@/platform/sharing/workspaces': { enableSharingSession: async () => {},
      createSharingWorkspace: () => assert.fail('normal new groups must not use the legacy creator'),
      createV2SharingWorkspace: async (name, kind) => { calls.push(['create', name, kind]); context.groups = [group]; return group; },
      requestSharingWorkspace: async () => { assert.fail('creation must not join/import personal data'); },
      subscribeSharingChanges: () => () => {}, sharingFailureMessage: () => '通信を確認してください。' },
    'expo-image': { Image: 'Image' },
  } });
  assert.match(screen.text(), /個人モードを使用中/); assert.equal(calls.length, 0);
  await screen.press('Googleで続ける'); assert.deepEqual(calls, [['google']]);
  assert.equal(screen.nodes().filter((n) => n.type === 'TextInput').length, 0);
  await screen.press('グループを作るを開く'); await screen.change('グループ名', '家族'); await chooseFamily(screen); await screen.press('グループを作成');
  assert.deepEqual(calls.at(-1), ['create', '家族', 'family']); assert.equal(context.active, null);
  await screen.press('このグループを開く'); assert.deepEqual(calls.at(-2), ['switch', group]); assert.deepEqual(calls.at(-1), ['navigate', 'replace', '/']);
  await screen.press('個人モードへ戻る'); assert.deepEqual(calls.at(-2), ['switch', null]);
  assert.ok(context.groups.includes(group), 'switching mode must preserve group membership');
});

test('sharing screen prevents duplicate creation while the first local commit is still running and allows retry after failure', async () => {
  let release; let count = 0;
  const context = { active: null, userId: 'owner', groups: [], ready: true, refreshSharing: async () => {} };
  const screen = screenHarness('src/app/sharing/index.tsx', { mocks: {
    '@/hooks/use-workspace': { useWorkspace: () => context }, 'expo-image': { Image: 'Image' },
    '@/platform/sharing/firebase-services': { isSharingConfigured: () => true },
    '@/platform/sharing/auth': { isSharingAppleSignInAvailable: async () => false },
    '@/platform/sharing/workspaces': { enableSharingSession: async () => {}, sharingFailureMessage: () => '通信を確認してください。',
      createSharingWorkspace: () => assert.fail('normal new groups must not use the legacy creator'),
      createV2SharingWorkspace: async () => { count++; await new Promise((resolve) => { release = resolve; }); throw new Error('synthetic'); } },
  } });
  await screen.press('グループを作るを開く'); await screen.change('グループ名', '家族');
  await chooseFamily(screen);
  const handler = screen.button('グループを作成').props.onPress;
  handler(); handler(); assert.equal(count, 1); release(); await screen.flush();
  assert.match(screen.text(), /通信を確認/); assert.equal(screen.button('グループを作成').props.disabled, false);
});

test('notification workspace lookup never crosses accounts, removed groups or unrelated notification types', () => {
  const data = { kind: 'daily-housework-digest', workspace: sharedGoogleNamespace('owner', 'group-test') };
  const groups = [{ userId: 'owner', groupId: 'group-test', status: 'active' }];
  assert.deepEqual(notificationWorkspace(data, 'owner', groups), { userId: 'owner', groupId: 'group-test' });
  assert.equal(notificationWorkspace(data, 'other', groups), undefined);
  assert.equal(notificationWorkspace(data, 'owner', [{ ...groups[0], status: 'removed' }]), undefined);
  assert.equal(notificationWorkspace({ ...data, workspace: 'group-test' }, 'owner', groups), undefined);
  assert.equal(notificationWorkspace({ kind: 'daily-housework-digest' }, null, []), null);
  assert.equal(notificationWorkspace({ kind: 'other' }, 'owner', groups), undefined);
});

for (const platform of ['ios', 'android']) test(`${platform} a cold notification waits for secure workspace restoration and duplicate events switch once`, async () => {
  const events = []; let listener; let effect; let stored;
  const context = { ready: false, userId: 'owner', groups: [{ userId: 'owner', groupId: 'group-test', status: 'active' }],
    switchTo: async (selection) => { events.push(['switch', selection]); } };
  const refs = []; let index = 0;
  const { NotificationWorkspaceBridge } = loadNativeModule('src/components/notification-workspace-bridge.tsx', {
    react: { useRef: (value) => refs[index++] ??= { current: value }, useEffect: (callback) => { effect = callback; } },
    'expo-router': { router: { replace: (route) => events.push(['route', route]) } },
    '@/hooks/use-workspace': { useWorkspace: () => context }, '@/features/notifications/workspace-response': { notificationWorkspace, isPlannerNotification },
    'expo-notifications': { addNotificationResponseReceivedListener: (callback) => { listener = callback; return { remove: () => events.push(['remove']) }; },
      getLastNotificationResponse: () => stored, clearLastNotificationResponse: () => { stored = null; events.push(['clear']); } },
  });
  stored = { actionIdentifier: 'default', notification: { request: { identifier: 'group-notification', content: { data: { kind: 'daily-housework-digest',
    workspace: sharedGoogleNamespace('owner', 'group-test') } } } } };
  NotificationWorkspaceBridge(); assert.equal(effect(), undefined); assert.deepEqual(events, []);
  context.ready = true; index = 0; NotificationWorkspaceBridge(); const cleanup = effect(); listener(stored); listener(stored);
  await new Promise(setImmediate); await new Promise(setImmediate);
  assert.deepEqual(events, [['switch', { userId: 'owner', groupId: 'group-test' }], ['route', '/'], ['clear']]);
  cleanup(); assert.deepEqual(events.at(-1), ['remove']);
});
