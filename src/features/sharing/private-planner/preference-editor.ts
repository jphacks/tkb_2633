import { createAutosaveQueue } from '../../settings/autosave-queue.ts';
import type { PrivatePlannerPreferenceStore } from './preference-store.ts';
import { snapshotPrivatePlannerPreferences } from './preferences.ts';
import type { PrivatePlannerPreferences, SavedPrivatePlannerPreferences } from './preferences.ts';
import type { Weekday } from '../../../domain/shared/types.ts';

export interface PrivatePreferenceDraft {
  timeZone: string; restDays: Weekday[]; heavy: string; normal: string;
  bands: { id: number; weekday: Weekday; start: string; end: string }[];
}
const time = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
function minute(raw: string, end: boolean) {
  const text = raw.normalize('NFKC').trim();
  if (end && text === '24:00') return 1440;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(text)) throw new Error('時間帯はHH:mmで入力してください。終了は24:00も指定できます。');
  const [hour, part] = text.split(':').map(Number); return hour * 60 + part;
}
function preferences(raw: PrivatePreferenceDraft) {
  if (!/^(?:[1-9]|10)$/u.test(raw.heavy) || !/^(?:[1-9]|1\d|20)$/u.test(raw.normal)) throw new Error('重い家事は1〜10件、普通の家事は1〜20件で入力してください。');
  return snapshotPrivatePlannerPreferences({ timeZone: raw.timeZone.trim(), restDays: [...raw.restDays],
    loadLimits: { heavyDailyLimit: Number(raw.heavy), normalDailyLimit: Number(raw.normal) },
    allowedBands: raw.bands.map(band => ({ weekday: band.weekday, startMinute: minute(band.start, false), endMinute: minute(band.end, true) })) });
}

/** Reuses the app's single-writer autosave and leave/background lifecycle; incomplete times never become permission. */
export function createPrivatePreferenceEditor(input: { store: PrivatePlannerPreferenceStore; saved: SavedPrivatePlannerPreferences | null;
  defaults: PrivatePlannerPreferences; delayMs?: number }) {
  let base = snapshotPrivatePlannerPreferences(input.saved ? { timeZone: input.saved.timeZone, restDays: input.saved.restDays,
    loadLimits: input.saved.loadLimits, allowedBands: input.saved.allowedBands } : input.defaults);
  let revision = input.saved?.revision ?? 0; let touched = false; let removalAllowed = false; let leaving = false; let nextId = 0; let navigationBlocked = false;
  const draftFor = (value: PrivatePlannerPreferences): PrivatePreferenceDraft => ({ timeZone: value.timeZone, restDays: [...value.restDays], heavy: String(value.loadLimits.heavyDailyLimit),
    normal: String(value.loadLimits.normalDailyLimit), bands: value.allowedBands.map(band => ({ id: nextId++, weekday: band.weekday, start: time(band.startMinute), end: time(band.endMinute) })) });
  let raw = draftFor(base);
  const listeners = new Set<() => void>();
  const queue = createAutosaveQueue<{ value: PrivatePlannerPreferences }>({ delayMs: input.delayMs,
    save: async ({ value }) => {
      const accepted = await input.store.save(revision, value); revision = accepted.revision;
      base = snapshotPrivatePlannerPreferences({ timeZone: accepted.timeZone, restDays: accepted.restDays, loadLimits: accepted.loadLimits, allowedBands: accepted.allowedBands });
    } });
  function snapshot() {
    let normalized: PrivatePlannerPreferences | null = null; let validation: string | null = null;
    try { normalized = preferences(raw); } catch (error) { validation = error instanceof Error ? error.message : '入力した内容を確認してください。'; }
    return { raw, status: queue.getSnapshot(), validation: touched ? validation : null, revision, removalAllowed, navigationBlocked,
      hasDraft: touched && (validation !== null || JSON.stringify(normalized) !== JSON.stringify(base)) };
  }
  let view = snapshot();
  function publish() { view = snapshot(); for (const listener of listeners) try { listener(); } catch { /* Observers cannot discard a queued save. */ } }
  queue.subscribe(publish);
  function change(update: (value: PrivatePreferenceDraft) => PrivatePreferenceDraft) {
    if (removalAllowed || leaving) return;
    raw = update({ ...raw, restDays: [...raw.restDays], bands: raw.bands.map(band => ({ ...band })) }); touched = true;
    try { queue.enqueue({ value: preferences(raw) }); } catch { queue.remove('value'); }
    publish();
  }
  async function flush() {
    const success = await queue.flush(); publish(); return success && !view.hasDraft;
  }
  return {
    getSnapshot: () => view, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    change, addBand(day: Weekday) { if (raw.bands.length < 56) change(value => ({ ...value, bands: [...value.bands, { id: nextId++, weekday: day, start: '', end: '' }] })); },
    flush,
    resumeNavigation() { removalAllowed = false; leaving = false; publish(); },
    discardDraft() { queue.remove('value'); raw = draftFor(base); touched = false; navigationBlocked = false; publish(); },
    async navigateAfterSave(navigate: () => void) {
      if (leaving) return false; leaving = true;
      if (!await flush()) { leaving = false; navigationBlocked = true; publish(); return false; }
      removalAllowed = true; publish(); navigate(); return true;
    },
  };
}
