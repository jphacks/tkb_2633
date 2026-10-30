const IDENTIFIER = /^[A-Za-z0-9_.:@-]{1,200}$/u;

export function assertSharedIdentifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error('Invalid shared identifier');
}
