import { bytesToHex } from '@noble/hashes/utils.js';
import type { createPrivateCalendarSecretStore } from '../private-calendar/secret-store.ts';
import type { createPrivateCalendarRootSetupStorage } from '../../../platform/storage/private-calendar-root-setup.ts';
import type { PrivateCalendarCryptoGateway } from '../private-calendar/crypto-gateway.ts';
import type { createPrivateCalendarCloud } from '../../../platform/sharing/private-calendar-cloud.ts';
import { verifyPrivateCalendarRoot } from '../private-calendar/authority.ts';
import { assertPrivateCalendarCloudAuthority } from '../private-calendar/cloud-contract.ts';
import { createPrivateCalendarFirstDeviceSetup } from '../private-calendar/first-device-setup.ts';

export interface PrivateCalendarRootAuditPort {
  userId: string; crypto: PrivateCalendarCryptoGateway; secrets: ReturnType<typeof createPrivateCalendarSecretStore>;
  intents: ReturnType<typeof createPrivateCalendarRootSetupStorage>;
  cloud: Pick<ReturnType<typeof createPrivateCalendarCloud>, 'createRoot' | 'readHead'>;
  assertOtherUserDenied(): Promise<void>;
}
export interface PrivateCalendarRootAuditResult {
  phase: 'prepared' | 'ready'; deviceId: string; rootDigest: string; keyProof: string | null; checks: string[];
}

/** Synthetic QA only. The prepared stage deliberately ends before the local pin/key commit. */
export async function auditPrivateCalendarRootSetup(development: boolean, action: 'prepare' | 'resume', port: PrivateCalendarRootAuditPort): Promise<PrivateCalendarRootAuditResult> {
  if (!development) throw new Error('開発ビルドだけで使用できます。');
  const { userId, crypto, secrets, intents, cloud } = port;
  if (!userId.startsWith('development-calendar-native-root-')) throw new Error('検査専用の保存先が必要です。');
  const checks: string[] = [];
  const check = (value: unknown, label: string) => { if (!value) throw new Error(`検査に失敗：${label}`); checks.push(label); };
  if (action === 'prepare') {
    const identity = await secrets.identity(userId); const intent = await intents.prepare(identity);
    if (intent.status !== 'pending' || await secrets.authority(userId)) throw new Error('準備済みの検査を続行してください。保存内容の初期化は行いません。');
    const root = verifyPrivateCalendarRoot(intent.signed, { ownerUserId: userId, accountGeneration: intent.signed.body.accountGeneration, rootDigest: intent.digest });
    check((await intents.read())?.digest === root.digest, '通信前に同じ署名済みrootを保存');
    assertPrivateCalendarCloudAuthority((await cloud.createRoot(root)).head, root); checks.push('Emulatorの実受付と準備内容が一致');
    check(await secrets.authority(userId) === null && (await intents.read())?.status === 'pending', '受付後も信頼pin・鍵の確定前で停止');
    await port.assertOtherUserDenied(); checks.push('別UIDのサーバー読取をRulesが拒否');
    return { phase: 'prepared', deviceId: identity.deviceId, rootDigest: root.digest, keyProof: null, checks };
  }
  const before = await intents.read(); if (!before) throw new Error('先に中断用の準備を実行してください。');
  const resumed = await createPrivateCalendarFirstDeviceSetup({ userId, secrets, intents, cloud }).resume();
  check(resumed.rootDigest === before.digest, '保存済みの同じrootから再開');
  const authority = await secrets.authority(userId); if (!authority) throw new Error('本人端末の信頼を復元できません。');
  check(authority.digest === before.digest, 'サーバー受付済みrootだけを保護領域へ確定');
  const head = await cloud.readHead(); if (!head) throw new Error('Emulatorの受付がありません。');
  assertPrivateCalendarCloudAuthority(head, authority); checks.push('再起動後も同じサーバー受付');
  let key: Uint8Array | null = null; let reloaded: Uint8Array | null = null;
  try {
    key = await secrets.currentKey(userId, authority); reloaded = await secrets.currentKey(userId, authority);
    if (!key || !reloaded || !crypto.digestSha256) throw new Error('保存済みの検査用鍵がありません。');
    const plain = new TextEncoder().encode('LiFlow Native root setup QA'); const aad = new TextEncoder().encode(authority.digest);
    const nonce = await crypto.randomBytes(12); const sealed = await crypto.encrypt(key, nonce, plain, aad);
    const opened = await crypto.decrypt(reloaded, nonce, sealed, aad);
    check(opened.length === plain.length && opened.every((byte, index) => byte === plain[index]), '保護領域の保存鍵でNative暗号を復元');
    check((await intents.read())?.status === 'ready', '同じ準備内容を完了へ確定');
    await port.assertOtherUserDenied(); checks.push('再起動後も別UIDの読取を拒否');
    return { phase: 'ready', deviceId: (await secrets.identity(userId)).deviceId, rootDigest: authority.digest, keyProof: bytesToHex(await crypto.digestSha256(key)), checks };
  } finally { key?.fill(0); reloaded?.fill(0); }
}
