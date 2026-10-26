import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadNativeModule } from './helpers/native-module.mjs';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as operations from '../src/features/sharing/operations.ts';

function fixture(platform = 'android') {
  const directory = platform === 'android' ? '/data/user/0/jp.test/files/SQLite' : 'file:///var/mobile/Containers/Data/Application/app/Documents/SQLite';
  let marker = null; const opens = [];
  const module = loadNativeModule('src/platform/sharing/database-location.ts', {
    'expo-file-system': { File: class { constructor(uri) { assert.ok(uri.startsWith('file:///'), 'FileSystem must receive an absolute file URI'); }
      get exists() { return marker !== null; } async text() { return JSON.stringify(marker); } } },
    'expo-sqlite': { defaultDatabaseDirectory: directory, async openDatabaseAsync(...args) { opens.push(args); return { name: args[0] }; } },
    'react-native': { Platform: { OS: platform } },
    '@noble/hashes/sha2.js': { sha256 }, '@noble/hashes/utils.js': { bytesToHex },
    '../../features/sharing/operations.ts': operations,
  });
  const path = platform === 'android' ? '/data/user/0/jp.test/no_backup/LiFlowSharedSQLite' : '/var/mobile/Containers/Data/Application/app/Documents/SQLite/shared';
  return { module, directory, path, opens, set: (value) => { marker = value; }, ready: () => { marker = { policyVersion: 1, platform, databaseDirectory: path }; } };
}

test('shared databases require a confirmed native backup-excluded directory on both mobile OSes', async () => {
  for (const platform of ['ios', 'android']) {
    const h = fixture(platform); await assert.rejects(h.module.openSharingDatabase('user', 'group'), /ビルド/); assert.equal(h.opens.length, 0);
    h.ready(); await h.module.openSharingDatabase('user', 'group');
    assert.equal(h.opens[0][2], `file://${h.path}`); assert.deepEqual(h.opens[0][1], { useNewConnection: true });
    for (const patch of [{ policyVersion: 2 }, { platform: 'web' }, { databaseDirectory: h.directory },
      { databaseDirectory: '/tmp/shared' }, { unsafe: true }]) {
      h.set({ policyVersion: 1, platform, databaseDirectory: h.path, ...patch });
      await assert.rejects(h.module.openSharingDatabase('user', 'group'));
    }
    assert.equal(h.opens.length, 1);
  }
});

test('group SQLite filenames are stable, opaque and independent for each user and group', () => {
  const h = fixture(); const one = h.module.sharingDatabaseFilename('user-a', 'group-a');
  assert.match(one, /^group-[a-f0-9]{64}\.db$/); assert.equal(h.module.sharingDatabaseFilename('user-a', 'group-a'), one);
  assert.notEqual(h.module.sharingDatabaseFilename('user-b', 'group-a'), one);
  assert.notEqual(h.module.sharingDatabaseFilename('user-a', 'group-b'), one);
  assert.throws(() => h.module.sharingDatabaseFilename('../escape', 'group-a'));
});

test('native container aliases on Android 10 and iOS remain inside the same app and backup-excluded directory', () => {
  const android = fixture('android');
  assert.equal(android.module.validateSharingDatabaseLocation({ policyVersion: 1, platform: 'android',
    databaseDirectory: '/data/data/jp.test/no_backup/LiFlowSharedSQLite' }, android.directory, 'android'),
    'file:///data/data/jp.test/no_backup/LiFlowSharedSQLite');
  assert.throws(() => android.module.validateSharingDatabaseLocation({ policyVersion: 1, platform: 'android',
    databaseDirectory: '/data/user/10/jp.test/no_backup/LiFlowSharedSQLite' }, android.directory, 'android'));
  const ios = fixture('ios');
  assert.equal(ios.module.validateSharingDatabaseLocation({ policyVersion: 1, platform: 'ios',
    databaseDirectory: '/private' + ios.path }, ios.directory, 'ios'), 'file:///private' + ios.path);
});
