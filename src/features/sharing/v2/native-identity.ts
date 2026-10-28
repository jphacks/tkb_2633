import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { assertSharedIdentifier } from '../identifier.ts';

/** Protocol/domain separation prevents v1 mappings, notifications or widgets being adopted as v2. */
export function v2NativeWorkspaceNamespace(userId: string, groupId: string) {
  assertSharedIdentifier(userId); assertSharedIdentifier(groupId);
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(['liflow-shared-v2-native', userId, groupId]))));
}
export function v2NotificationPrefix(userId: string, groupId: string) {
  return `liflow-v2-digest:${v2NativeWorkspaceNamespace(userId, groupId)}:`;
}
