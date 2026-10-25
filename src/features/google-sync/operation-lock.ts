let operationTail: Promise<unknown> = Promise.resolve();

/** Settings and the existing sync promise share a queue; no overlapping schedule mutations. */
export function withGoogleSyncOperation<T>(operation: () => Promise<T>): Promise<T> {
  const pending = operationTail.then(operation, operation);
  operationTail = pending.then(() => undefined, () => undefined);
  return pending;
}
