import type { ChoreDefinition } from './types';

/** Same category and item order in settings, connected editors and guides. */
export function groupChores(chores: readonly ChoreDefinition[]): [string, ChoreDefinition[]][] {
  const groups = new Map<string, ChoreDefinition[]>();
  for (const chore of chores) if (!chore.archived) {
    const rows = groups.get(chore.category) ?? []; rows.push(chore); groups.set(chore.category, rows);
  }
  return [...groups];
}

export function validateChoreToggle(ids: unknown, enabled: unknown): asserts ids is string[] {
  if (typeof enabled !== 'boolean' || !Array.isArray(ids) || !ids.length || ids.length > 1000
    || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new Error('切り替える家事を確認してください。');
}
