/** Native dictionary/property order may change between reads. Preserve every JSON value and request. */
export function serializeNotificationRequests(requests: readonly { identifier: string }[]): string {
  return JSON.stringify([...requests].sort((a, b) => a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0),
    (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
}
