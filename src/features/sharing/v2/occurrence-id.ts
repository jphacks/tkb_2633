import { sharedDocumentDigest } from '../crypto.ts';
import { assertSharedIdentifier } from '../identifier.ts';
import { parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';

/** Dates selected by a person and rule versions do not participate in the identity of a common cycle. */
export function v2OccurrenceId(groupId: string, choreId: string, anchorDate: LocalDate): string {
  assertSharedIdentifier(groupId); assertSharedIdentifier(choreId); parseLocalDate(anchorDate);
  return `v2.${sharedDocumentDigest([groupId, choreId, anchorDate])}`;
}
export function v2SubjectOccurrenceId(commonId: string, subjectUserId: string | null): string {
  assertSharedIdentifier(commonId);
  if (subjectUserId === null) return commonId;
  assertSharedIdentifier(subjectUserId);
  return `${commonId}.${sharedDocumentDigest([subjectUserId])}`;
}
