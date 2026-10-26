import type { SQLiteDatabase } from 'expo-sqlite';
import { assertSharedIdentifier, canonicalJson } from '../../features/sharing/operations.ts';
import { sharedRosterDigest, validateSharedRoster } from '../../features/sharing/roster.ts';
import type { SignedSharedRoster } from '../../features/sharing/roster.ts';
import type { WrappedGroupKey } from '../../features/sharing/crypto.ts';
import type { SharedInvitationPin, SharedJoinRequest, SignedSharedInvitation } from '../../features/sharing/invitations.ts';

export type SharingWorkspaceStatus = 'creating' | 'joining' | 'active' | 'left' | 'removed';
export interface SharingWorkspaceRecord {
  userId: string;
  groupId: string;
  displayName: string;
  status: SharingWorkspaceStatus;
  anchor: SignedSharedRoster | SharedInvitationPin;
  rosterArchive: SignedSharedRoster[];
  createdAt: string;
  lastSuccessfulSyncAt: number | null;
  lastErrorCode: string | null;
  /** A new approval uses a fresh database/key pair; earlier offline edits remain archived locally. */
  localGeneration?: string;
  archivedLocalGenerations?: string[];
  creation?: { timeZone: string; anchorDate: string; ownerDisplayName: string; wrappedKey: WrappedGroupKey };
  join?: { invitation: SignedSharedInvitation; request: SharedJoinRequest };
}
const tails = new WeakMap<SQLiteDatabase, Promise<unknown>>();
function serial<T>(database: SQLiteDatabase, operation: () => Promise<T>): Promise<T> {
  const next = (tails.get(database) ?? Promise.resolve()).then(operation, operation);
  const tail = next.then(() => undefined, () => undefined); tails.set(database, tail);
  void tail.then(() => { if (tails.get(database) === tail) tails.delete(database); }); return next;
}
function validate(record: SharingWorkspaceRecord): SharingWorkspaceRecord {
  assertSharedIdentifier(record.userId); assertSharedIdentifier(record.groupId);
  if (record.localGeneration) assertSharedIdentifier(record.localGeneration);
  if (record.archivedLocalGenerations) {
    if (!Array.isArray(record.archivedLocalGenerations) || record.archivedLocalGenerations.length > 512) throw new Error('Too many archived workspace generations');
    for (const generation of record.archivedLocalGenerations) assertSharedIdentifier(generation);
  }
  if (!record.displayName.trim() || record.displayName.length > 500 || !['creating', 'joining', 'active', 'left', 'removed'].includes(record.status)
    || !Number.isFinite(Date.parse(record.createdAt)) || !Array.isArray(record.rosterArchive) || record.rosterArchive.length > 4096) throw new Error('Invalid sharing workspace');
  if ('body' in record.anchor) {
    if (validateSharedRoster(record.anchor).body.groupId !== record.groupId) throw new Error('Workspace pin group mismatch');
  } else if (record.anchor.groupId !== record.groupId) throw new Error('Workspace invitation group mismatch');
  // The whitelist encoder refuses OAuth credentials, group keys and device secret keys.
  return JSON.parse(canonicalJson(record)) as SharingWorkspaceRecord;
}
function anchorDigest(anchor: SharingWorkspaceRecord['anchor']): string {
  return 'body' in anchor ? sharedRosterDigest(anchor) : anchor.digest;
}

export function initializeSharingRegistry(database: SQLiteDatabase): Promise<void> {
  return serial(database, () => database.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS sharing_workspaces (
      user_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY(user_id, group_id)
    );
  `));
}

export function listSharingWorkspaces(database: SQLiteDatabase, userId: string): Promise<SharingWorkspaceRecord[]> {
  assertSharedIdentifier(userId);
  return serial(database, async () => (await database.getAllAsync<{ group_id: string; record_json: string }>(
    'SELECT group_id, record_json FROM sharing_workspaces WHERE user_id = ? ORDER BY group_id', userId,
  )).map((row) => {
    const record = validate(JSON.parse(row.record_json));
    if (record.userId !== userId || record.groupId !== row.group_id) throw new Error('Stored workspace identity mismatch');
    return record;
  }));
}

export function readSharingWorkspace(database: SQLiteDatabase, userId: string, groupId: string): Promise<SharingWorkspaceRecord | null> {
  assertSharedIdentifier(userId); assertSharedIdentifier(groupId);
  return serial(database, async () => {
    const row = await database.getFirstAsync<{ record_json: string }>('SELECT record_json FROM sharing_workspaces WHERE user_id = ? AND group_id = ?', userId, groupId);
    const record = row ? validate(JSON.parse(row.record_json)) : null;
    if (record && (record.userId !== userId || record.groupId !== groupId)) throw new Error('Stored workspace identity mismatch');
    return record;
  });
}

export function saveSharingWorkspace(database: SQLiteDatabase, input: SharingWorkspaceRecord): Promise<void> {
  const record = validate(input);
  return serial(database, async () => {
    await database.runAsync('INSERT OR IGNORE INTO sharing_workspaces (user_id, group_id, record_json) VALUES (?, ?, ?)', record.userId, record.groupId, canonicalJson(record));
    const row = await database.getFirstAsync<{ record_json: string }>('SELECT record_json FROM sharing_workspaces WHERE user_id = ? AND group_id = ?', record.userId, record.groupId);
    const stored = row ? validate(JSON.parse(row.record_json)) : null;
    if (!stored || anchorDigest(stored.anchor) !== anchorDigest(record.anchor)) throw new Error('A cloud response cannot replace a locally trusted group pin');
  });
}

/** Changes read the latest row inside the queue, so a late sync result cannot restore a departed workspace. */
export function updateSharingWorkspace(database: SQLiteDatabase, userId: string, groupId: string,
  change: (current: SharingWorkspaceRecord) => SharingWorkspaceRecord): Promise<SharingWorkspaceRecord> {
  return serial(database, async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const row = await database.getFirstAsync<{ record_json: string }>('SELECT record_json FROM sharing_workspaces WHERE user_id = ? AND group_id = ?', userId, groupId);
      if (!row) throw new Error('共有グループが見つかりません。');
      const old = validate(JSON.parse(row.record_json)); const previousPin = anchorDigest(old.anchor); const previousStatus = old.status; const previousGeneration = old.localGeneration;
      const next = validate(change(old));
      if (next.userId !== userId || next.groupId !== groupId || anchorDigest(next.anchor) !== previousPin) throw new Error('Workspace identity or pin cannot change');
      if (['left', 'removed'].includes(previousStatus) && next.status === 'active') throw new Error('Explicitly request group approval before rejoining');
      if (next.localGeneration !== previousGeneration && (!['left', 'removed'].includes(previousStatus) || next.status !== 'joining'
        || !next.localGeneration || !next.archivedLocalGenerations?.includes(previousGeneration ?? 'initial'))) throw new Error('Rejoining must preserve the previous local workspace');
      const result = await database.runAsync('UPDATE sharing_workspaces SET record_json = ? WHERE user_id = ? AND group_id = ? AND record_json = ?',
        canonicalJson(next), userId, groupId, row.record_json);
      if (result.changes === 1) return next;
    }
    throw new Error('共有状態の更新が重なりました。もう一度お試しください。');
  });
}
