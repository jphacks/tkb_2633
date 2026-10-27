import { collection, doc, documentId, getDocFromServer, getDocsFromServer, limit, onSnapshot, orderBy, query,
  runTransaction, serverTimestamp, startAfter, where, writeBatch } from 'firebase/firestore';
import type { Firestore, QueryDocumentSnapshot } from 'firebase/firestore';
import { assertSharedIdentifier, canonicalJson } from '../../features/sharing/operations.ts';
import { assertSharedCloudAccess, parseSharedCloudEvent, parseSharedCloudGroup, rosterCloudFields,
  SharingAccessError, SharingKeyVersionError, SharingSchedulerVersionError, SharingSnapshotRequiredError } from '../../features/sharing/cloud-contract.ts';
import type { EncryptedSharedOperation, WrappedGroupKey } from '../../features/sharing/crypto.ts';
import type { VerifiedSharedRoster } from '../../features/sharing/roster.ts';
import { createSharingManagement } from './firestore-management.ts';
import { sharingCloudWithDeadline } from './network-deadline.ts';

/** All reads use the server; Firestore's memory cache cannot acknowledge delivery. */
export function createSharingCloud(firestore: Firestore, userId: string, currentUserId: () => string | null) {
  assertSharedIdentifier(userId);
  const checkAccount = () => { if (currentUserId() !== userId) throw new SharingAccessError('共有アカウントが切り替わりました。'); };
  const reference = (groupId: string) => { assertSharedIdentifier(groupId); return doc(firestore, 'sharingGroups', groupId); };
  const readGroup = async (groupId: string) => {
    checkAccount(); const response = await getDocFromServer(reference(groupId)); checkAccount();
    const parsed = parseSharedCloudGroup(response.data(), groupId); assertSharedCloudAccess(parsed.group, userId);
    return parsed;
  };
  return sharingCloudWithDeadline({
    ...createSharingManagement({ firestore, userId, checkAccount, reference, readGroup }),
    readGroup,
    async listMemberships(): Promise<string[]> {
      const memberships: string[] = []; let cursor: QueryDocumentSnapshot | undefined;
      do {
        checkAccount(); const page = await getDocsFromServer(query(collection(firestore, 'sharingUsers', userId, 'memberships'),
          orderBy(documentId()), limit(100), ...(cursor ? [startAfter(cursor)] : [])));
        checkAccount(); memberships.push(...page.docs.map((item) => { assertSharedIdentifier(item.id); return item.id; }));
        if (page.size < 100) return memberships;
        cursor = page.docs.at(-1);
      } while (cursor);
      return memberships;
    },
    async hasMembership(groupId: string): Promise<boolean> {
      assertSharedIdentifier(groupId); checkAccount();
      const result = await getDocFromServer(doc(firestore, 'sharingUsers', userId, 'memberships', groupId));
      checkAccount(); return result.exists();
    },
    async createGroup(roster: VerifiedSharedRoster, wrapped: WrappedGroupKey): Promise<void> {
      checkAccount();
      if (roster.body.ownerUserId !== userId || roster.body.revision !== 1 || wrapped.recipientUserId !== userId
        || wrapped.groupId !== roster.body.groupId || wrapped.keyVersion !== 1 || wrapped.recipientDeviceId !== roster.body.ownerDeviceId
        || wrapped.senderDeviceId !== roster.body.ownerDeviceId) {
        throw new Error('Invalid initial group authority');
      }
      const ref = reference(roster.body.groupId); const batch = writeBatch(firestore);
      batch.set(ref, { ...rosterCloudFields(roster), headSequence: 0, lastOperationId: null, snapshotId: null,
        snapshotThroughSequence: 0, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      batch.set(doc(ref, 'rosters', '1'), { rosterJson: canonicalJson(roster), createdAt: serverTimestamp() });
      batch.set(doc(ref, 'keyEnvelopes', `1_${wrapped.recipientDeviceId}`), { userId, deviceId: wrapped.recipientDeviceId,
        keyVersion: 1, wrappedKeyJson: canonicalJson(wrapped), createdAt: serverTimestamp() });
      batch.set(doc(firestore, 'sharingUsers', userId, 'memberships', roster.body.groupId),
        { groupId: roster.body.groupId, createdAt: serverTimestamp() });
      try { await batch.commit(); }
      catch (error) {
        // Retrying an uncertain create must recover its exact prepared key, never replace it.
        try {
          checkAccount();
          const original = await getDocFromServer(doc(ref, 'rosters', '1'));
          const key = await getDocFromServer(doc(ref, 'keyEnvelopes', `1_${wrapped.recipientDeviceId}`));
          if (original.data()?.rosterJson !== canonicalJson(roster) || key.data()?.wrappedKeyJson !== canonicalJson(wrapped)) throw error;
        } catch { throw error; }
      }
      checkAccount();
    },
    async readRoster(groupId: string, revision: number) {
      checkAccount(); if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid roster revision');
      const result = await getDocFromServer(doc(reference(groupId), 'rosters', String(revision))); checkAccount();
      const encoded = result.data()?.rosterJson;
      if (typeof encoded !== 'string' || encoded.length > 60_000) throw new Error('Missing membership history');
      return JSON.parse(encoded);
    },
    async readGroupKey(groupId: string, version: number, deviceId: string): Promise<WrappedGroupKey> {
      checkAccount(); assertSharedIdentifier(deviceId);
      if (!Number.isSafeInteger(version) || version < 1) throw new Error('Invalid key epoch');
      const result = await getDocFromServer(doc(reference(groupId), 'keyEnvelopes', `${version}_${deviceId}`)); checkAccount();
      const data = result.data();
      if (data?.userId !== userId || data?.deviceId !== deviceId || data?.keyVersion !== version
        || typeof data?.wrappedKeyJson !== 'string' || data.wrappedKeyJson.length > 10_000) throw new Error('Missing device key envelope');
      return JSON.parse(data.wrappedKeyJson) as WrappedGroupKey;
    },
    async upload(envelope: EncryptedSharedOperation) {
      checkAccount(); assertSharedIdentifier(envelope.operationId);
      const ref = reference(envelope.groupId); const event = doc(ref, 'events', envelope.operationId);
      const envelopeJson = canonicalJson(envelope);
      if (envelopeJson.length > 800_000 || envelope.authorUserId !== userId) throw new Error('Invalid upload author or size');
      const result = await runTransaction(firestore, async (transaction) => {
        checkAccount();
        const root = await transaction.get(ref);
        const { group } = parseSharedCloudGroup(root.data(), envelope.groupId);
        assertSharedCloudAccess(group, userId, envelope.authorDeviceId);
        if (envelope.schemaVersion !== group.schemaVersion) throw new SharingSchedulerVersionError();
        // A successful response may have been lost. Never create a second event or nonce.
        const old = await transaction.get(event);
        if (old.exists()) {
          const accepted = parseSharedCloudEvent(old.id, old.data(), envelope.groupId);
          if (accepted.envelope.authorUserId !== envelope.authorUserId || accepted.envelope.authorDeviceId !== envelope.authorDeviceId
            || accepted.envelope.logicalClock !== envelope.logicalClock) throw new Error('Shared operation ID collision');
          return accepted;
        }
        if (group.rotationRequired || group.keyVersion !== envelope.keyVersion) throw new SharingKeyVersionError('共有鍵を更新してから再送します。');
        const sequence = group.headSequence + 1;
        if (!Number.isSafeInteger(sequence)) throw new Error('Shared log sequence exhausted');
        const fields = { schemaVersion: envelope.schemaVersion, authorUserId: userId, authorDeviceId: envelope.authorDeviceId,
          keyVersion: envelope.keyVersion, uploadSequence: sequence, envelopeJson };
        transaction.set(event, { ...fields, createdAt: serverTimestamp() });
        transaction.update(ref, { headSequence: sequence, lastOperationId: envelope.operationId, updatedAt: serverTimestamp() });
        return parseSharedCloudEvent(envelope.operationId, fields, envelope.groupId);
      });
      checkAccount(); return result;
    },
    async pull(groupId: string, afterSequence: number) {
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('Invalid shared receive position');
      const metadata = await readGroup(groupId); const { group } = metadata;
      if (afterSequence > group.headSequence) throw new SharingSnapshotRequiredError('共有履歴が保存位置より前に戻っています。');
      if (afterSequence < group.snapshotThroughSequence) throw new SharingSnapshotRequiredError('共有データのSnapshotを取得します。');
      const page = await getDocsFromServer(query(collection(reference(groupId), 'events'), orderBy('uploadSequence'),
        startAfter(afterSequence), where('uploadSequence', '<=', group.headSequence), limit(100)));
      checkAccount();
      const events = page.docs.map((item) => parseSharedCloudEvent(item.id, item.data(), groupId));
      if (events.some((event, index) => event.uploadSequence !== afterSequence + index + 1)
        || (!events.length && afterSequence < group.headSequence)) throw new SharingSnapshotRequiredError('共有履歴の保存位置が更新されました。');
      return { ...metadata, events, throughSequence: events.at(-1)?.uploadSequence ?? afterSequence };
    },
    watch(groupId: string, changed: () => void, failed: (error: unknown) => void): () => void {
      checkAccount();
      return onSnapshot(reference(groupId), (snapshot) => {
        try { checkAccount(); if (!snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) changed(); }
        catch (error) { failed(error); }
      }, failed);
    },
  });
}
