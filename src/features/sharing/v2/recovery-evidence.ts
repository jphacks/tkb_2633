import type { SharingCloud } from '../synchronizer.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import type { SignedV2RecoveryWitness } from './recovery-witness.ts';
import type { RawV2RecoveryEvent } from './recovery-contract.ts';

/** A signed owner decision must still match the independently retained server ciphertext and receipt. */
export async function readV2RecoveryEvidence(cloud: SharingCloud, groupId: string, witnesses: readonly SignedV2RecoveryWitness[],
  assertCurrentAccount: () => void, deadlineAtMs: number): Promise<RawV2RecoveryEvent[]> {
  const originals: RawV2RecoveryEvent[] = [];
  for (const witness of witnesses) {
    assertCurrentAccount(); const { body } = witness;
    const record = await cloud.readRecoveryRecord(groupId, body.snapshotId); assertCurrentAccount();
    if (!record || record.snapshotId !== body.snapshotId || record.previousKeyVersion !== body.previousKeyVersion || record.keyVersion !== body.keyVersion
      || record.throughSequence !== body.throughSequence || record.reviewDigest !== body.reviewDigest) throw new Error('Recovery decision lacks its immutable encrypted server preparation');
    const ids = body.entries.map(entry => entry.operationId);
    const raw = await cloud.readRecoveryOriginals(groupId, ids); assertCurrentAccount();
    const tombstones = await cloud.readRecoveryQuarantines(groupId, ids); assertCurrentAccount();
    const receipts = await cloud.readReceipts(groupId, ids, { deadlineAtMs }); assertCurrentAccount();
    if (Date.now() >= deadlineAtMs) throw Object.assign(new Error('復旧の証拠の取得は次の同期で続けます。'), { code: 'sharing/receipt-recovery-pending' });
    const events = new Map(raw.map(value => [value.operationId, value]));
    const quarantine = new Map(tombstones.map(value => [value.operationId, value]));
    const received = new Map(receipts.map(value => [value.operationId, value]));
    if (events.size !== ids.length || quarantine.size !== ids.length || events.size !== raw.length || quarantine.size !== tombstones.length
      || received.size !== receipts.length || [...received.keys()].some(id => !events.has(id))) throw new Error('Recovery original evidence is missing duplicated or foreign');
    for (const entry of body.entries) {
      const event = events.get(entry.operationId)!; const protectedEvent = quarantine.get(entry.operationId)!;
      const receipt = received.get(entry.operationId);
      if (event.groupId !== groupId || event.uploadSequence !== entry.uploadSequence || event.keyVersion !== entry.keyVersion
        || event.authorUserId !== entry.authorUserId || event.authorDeviceId !== entry.authorDeviceId || sharedDocumentDigest(event) !== entry.rawDigest
        || protectedEvent.rawDigest !== entry.rawDigest || protectedEvent.uploadSequence !== entry.uploadSequence || protectedEvent.keyVersion !== entry.keyVersion
        || (receipt ? sharedDocumentDigest(receipt) : null) !== entry.receiptDigest) throw new Error('Owner recovery decision differs from the immutable original evidence');
      originals.push(event);
    }
  }
  return originals;
}
