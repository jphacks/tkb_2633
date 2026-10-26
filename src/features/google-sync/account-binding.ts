/** A different Google session must never reuse another account's persisted task mappings. */
export class GoogleAccountMismatchError extends Error {
  readonly code = 'google_account_mismatch';
  constructor() {
    super('以前連携したGoogleアカウントを選択してください。');
    this.name = 'GoogleAccountMismatchError';
  }
}

export async function verifyGoogleAccountBinding(input: {
  boundSubject?: string;
  currentSubject: string;
  legacyTaskListIds: readonly string[];
  listOwnedTaskListIds(): Promise<readonly string[]>;
  persistSubject(subject: string): Promise<void>;
}): Promise<void> {
  if (typeof input.currentSubject !== 'string' || !input.currentSubject
    || (input.boundSubject && input.boundSubject !== input.currentSubject)) throw new GoogleAccountMismatchError();
  if (input.boundSubject) return;
  if (input.legacyTaskListIds.length) {
    const owned = new Set(await input.listOwnedTaskListIds());
    if (input.legacyTaskListIds.some((id) => !owned.has(id))) throw new GoogleAccountMismatchError();
  }
  await input.persistSubject(input.currentSubject);
}
