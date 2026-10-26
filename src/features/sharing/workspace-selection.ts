import { assertJsonRecord, assertSharedIdentifier, canonicalJson } from './operations.ts';

export interface SharingSelection { userId: string; groupId: string }

function selectionFrom(input: unknown): SharingSelection {
  assertJsonRecord(input);
  assertSharedIdentifier(input.userId); assertSharedIdentifier(input.groupId);
  return { userId: input.userId, groupId: input.groupId };
}

/** Screen records have additional fields at runtime despite the narrower TypeScript type. */
export function encodeSharingSelection(selection: SharingSelection): string {
  return canonicalJson(selectionFrom(selection));
}

/** Older builds saved a whole registry record. Its metadata never grants group access. */
export function decodeSharingSelection(saved: string): SharingSelection {
  return selectionFrom(JSON.parse(saved));
}
