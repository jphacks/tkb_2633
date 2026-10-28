import { bytesToHex } from '@noble/hashes/utils.js';
import { signSharedDocument, verifySharedDocument } from '../crypto.ts';
import { createPrivateCalendarRoot } from '../private-calendar/authority.ts';
import type { PrivateCalendarCryptoGateway } from '../private-calendar/crypto-gateway.ts';
import type { createPrivateCalendarSecretStore } from '../private-calendar/secret-store.ts';

export const PRIVATE_CALENDAR_STORE_QA_USER_ID = 'development-calendar-native-store-v1';
export interface PrivateCalendarStoredAuditResult {
  mode: 'created' | 'restored'; deviceId: string; authorityDigest: string; storageProof: string; checks: string[];
}
/** Only newly created QA material is used. The public proof is a checksum, never a secret key or an account identifier. */
export async function auditPrivateCalendarStoredState(input: { development: boolean; crypto: PrivateCalendarCryptoGateway;
  store: ReturnType<typeof createPrivateCalendarSecretStore> }): Promise<PrivateCalendarStoredAuditResult> {
  if (!input.development) throw new Error('開発ビルドだけで使用できます。');
  const { store, crypto } = input; if (!crypto.digestSha256) throw new Error('Native SHA-256が準備されていません。');
  const userId = PRIVATE_CALENDAR_STORE_QA_USER_ID; const checks: string[] = [];
  const assert = (condition: boolean, label: string) => { if (!condition) throw new Error(`検査に失敗：${label}`); checks.push(label); };
  const identity = await store.identity(userId); let authority = await store.authority(userId);
  const mode = authority ? 'restored' : 'created'; let key: Uint8Array | null = null; let reloaded: Uint8Array | null = null;
  try {
    if (!authority) {
      authority = await createPrivateCalendarRoot(crypto, userId, identity);
      await store.confirmTrust(userId, authority, 'firstDeviceSetup');
      key = await store.createCurrentKey(userId, authority);
    } else key = await store.currentKey(userId, authority);
    if (!key) throw new Error('保存済みの本人用鍵を復元できません。自動再生成はしません。');
    const challenge = { suite: 'liflow-private-calendar-store-qa-v1', userId, deviceId: identity.deviceId };
    const signature = signSharedDocument(challenge, identity); verifySharedDocument(challenge, signature, identity);
    checks.push('保存済みの端末鍵で署名を検証');
    const persisted = await store.authority(userId);
    assert(persisted?.digest === authority.digest && persisted.signed.body.ownerUserId === userId, '署名済みの本人設定を安全な領域から復元');
    reloaded = await store.currentKey(userId, authority);
    assert(reloaded !== null && key.every((byte, index) => byte === reloaded![index]), '同じ鍵世代の内容を再読込して照合');
    const plaintext = new TextEncoder().encode('LiFlow private Calendar persisted QA proof');
    const nonce = await crypto.randomBytes(12); const aad = new TextEncoder().encode(authority.digest);
    if (nonce.length !== 12) throw new Error('安全な乱数を生成できません。');
    const ciphertext = await crypto.encrypt(key, nonce, plaintext, aad);
    const opened = await crypto.decrypt(reloaded!, nonce, ciphertext, aad);
    assert(opened.length === plaintext.length && opened.every((byte, index) => byte === plaintext[index]), 'Native AES-GCMで保存鍵の一致を検証');
    const proof = await crypto.digestSha256(key); if (proof.length !== 32) throw new Error('保存の照合値を確認できません。');
    const storageProof = bytesToHex(proof);
    return { mode, deviceId: identity.deviceId, authorityDigest: authority.digest, storageProof, checks };
  } finally { key?.fill(0); reloaded?.fill(0); }
}
