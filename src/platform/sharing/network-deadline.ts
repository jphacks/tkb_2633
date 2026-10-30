/** Firestore can retain writes while offline. Bound the caller without claiming cancellation.
 * A late successful immutable upload is recovered by its exact operation ID/ciphertext on retry.
 */
export function sharingCloudWithDeadline<T extends object>(cloud: T, milliseconds = 30_000): T {
  if (!Number.isFinite(milliseconds) || milliseconds < 1) throw new Error('Invalid sharing network deadline');
  const wrapped = { ...cloud };
  for (const key of Object.keys(cloud) as (keyof T)[]) {
    const method = cloud[key];
    if (key === 'watch' || typeof method !== 'function') continue;
    wrapped[key] = ((...args: unknown[]) => {
      const pending = Promise.resolve(Reflect.apply(method, cloud, args));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error('Sharing request timed out; delivery remains unconfirmed'), { code: 'unavailable' })), milliseconds);
        pending.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
      });
    }) as T[keyof T];
  }
  return wrapped;
}
