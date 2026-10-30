import type { DesignationOptions } from './model.ts';

/** A counteroffer may add an explicit administrator exception, never weaken the original locks. */
export function counterofferDesignationOptions(original: DesignationOptions, allowDuringCooldown: unknown): DesignationOptions {
  return { ...original, ...(allowDuringCooldown === true ? { allowDuringCooldown: true } : {}) };
}
