import type { PrivateCalendarCapturePort } from './calendar-capture.ts';
import { createPrivateCalendarCapture } from './calendar-capture.ts';
import type { PrivateCalendarDeviceSession } from './device-session.ts';
import type { createPrivateCalendarSourceController } from './source-controller.ts';
import { privateCalendarSourceBinding } from './source-controller.ts';
import type { PrivateBusyCache, PrivateBusyBinding } from '../v2/private-availability.ts';
import { createPrivateCalendarReader } from '../v2/private-availability.ts';
import type { DateTarget } from '../v2/model.ts';
import { sharedLocalDate } from '../group-clock.ts';
import { addDays } from '../../../domain/scheduling/local-date.ts';
import { createCalendarQueryRange } from '../../google-sync/calendar-availability.ts';

export interface PrivateCalendarRuntimePort extends PrivateCalendarCapturePort {
  devices: PrivateCalendarDeviceSession; sourceController: ReturnType<typeof createPrivateCalendarSourceController>;
  cloud: PrivateCalendarCapturePort['cloud'] & { readCache: (authority: NonNullable<Awaited<ReturnType<PrivateCalendarCapturePort['secrets']['authority']>>>) => Promise<import('./cache-crypto').EncryptedPrivateCalendarCache | null> };
  timeZone(): string;
  currentGoogleAccount(): Promise<{ subject: string; label: string } | null>;
  restoreGoogleAccount?: () => Promise<{ subject: string; label: string }>;
  authorizeGoogleSource(expectedSubject: string): Promise<void>;
}
export function createPrivateCalendarRuntime(port: PrivateCalendarRuntimePort) {
  const { userId, devices, secrets, source, cache, cloud, sourceController, now = Date.now } = port;
  const capture = createPrivateCalendarCapture(port); const listeners = new Set<() => void>();
  let memo: { id: string; promise: Promise<PrivateBusyCache | null> } | null = null;
  let requiresSourceReview = false;
  function invalidate() { memo = null; for (const listener of listeners) try { listener(); } catch { /* A view cannot invalidate a committed setting. */ } }
  async function readSettings() {
    await port.assertOwner(); const device = await devices.read();
    const profile = device.authorityDigest ? await source.read() : null; await port.assertOwner();
    return { ownerUserId: userId, device, connected: Boolean(profile?.active?.googleSubject) && !requiresSourceReview, requiresSourceReview, pendingTargetDigest: profile?.pending?.digest ?? null,
      cacheSaved: device.cache?.authorityCurrent === true };
  }
  async function assertMain(expected?: string) {
    await port.assertOwner(); const state = await secrets.publicState(userId); const authority = state?.authority;
    if (!authority || authority.signed.body.mainDeviceId !== state.identity.deviceId || expected && authority.digest !== expected) throw new Error('表示したメイン端末の設定を確認してください。');
    await port.assertOwner(); return authority;
  }
  let action: Promise<unknown> | null = null;
  function mutate<T>(work: () => Promise<T>): Promise<T> {
    if (action) return Promise.reject(new Error('本人用Calendarの操作が終わってから再試行してください。'));
    invalidate(); const pending = (async () => { await port.assertOwner(); const value = await work(); await port.assertOwner(); return value; })(); action = pending;
    void pending.finally(() => { if (action === pending) action = null; invalidate(); }).catch(() => {}); return pending;
  }
  async function readForPlan(): Promise<{ ownerUserId: string; cache: PrivateBusyCache; binding: PrivateBusyBinding } | null> {
    await port.assertOwner(); const state = await secrets.publicState(userId); const authority = state?.authority;
    if (!authority || !authority.signed.body.devices.some(device => device.deviceId === state.identity.deviceId) || !state.hasCurrentKey) return null;
    const selected = await source.read();
    if (selected?.pending || authority.signed.body.mainDeviceId === state.identity.deviceId && (!selected?.active?.googleSubject || requiresSourceReview)) return null;
    const status = await cache.status(authority); if (!status?.authorityCurrent) return null;
    const calendarBinding = privateCalendarSourceBinding(authority); const id = `${authority.digest}:${status.cursor.manifestDigest}`;
    let current = memo;
    if (!current || current.id !== id) {
      const promise = (async () => {
        const key = await secrets.currentKey(userId, authority);
        try {
          const body = key ? await cache.read({ authority, accountKey: key, calendarBinding }) : null;
          if (body) { for (const part of body.intervals) Object.freeze(part); Object.freeze(body.intervals); Object.freeze(body.coverage); Object.freeze(body); }
          return body;
        }
        finally { key?.fill(0); }
      })(); current = { id, promise }; memo = current;
    }
    try {
      const body = await current.promise; const after = await secrets.publicState(userId); const profile = await source.read(); const latest = await cache.status(authority); await port.assertOwner();
      if (!body || memo !== current || after?.authority?.digest !== authority.digest || profile?.pending || !latest?.authorityCurrent || latest.cursor.manifestDigest !== status.cursor.manifestDigest
        || authority.signed.body.mainDeviceId === state.identity.deviceId && profile?.active?.googleSubject !== selected?.active?.googleSubject) return null;
      return { ownerUserId: userId, cache: body, binding: { ownerUserId: userId, accountGeneration: authority.anchor.accountGeneration,
        mainDeviceId: authority.signed.body.mainDeviceId, mainRevision: authority.signed.body.revision, calendarBinding } };
    } catch { if (memo === current) memo = null; await port.assertOwner(); return null; }
  }
  let refresh: ReturnType<typeof update> | null = null;
  function refreshData() {
    if (refresh) return refresh;
    const pending = mutate(update); refresh = pending; void pending.finally(() => { if (refresh === pending) refresh = null; }).catch(() => {}); return pending;
  }
  async function update() {
    const device = await devices.synchronizeDevices();
    if (device.phase !== 'approved') return { kind: 'unavailable' as const };
    if ((await source.read())?.pending) {
      const resumed = await sourceController.resume(); if (resumed.kind === 'review') return resumed;
    }
    const state = await secrets.publicState(userId); const authority = state?.authority;
    if (!authority || !authority.signed.body.devices.some(value => value.deviceId === state.identity.deviceId)) return { kind: 'unavailable' as const };
    if (authority.signed.body.mainDeviceId === state.identity.deviceId) {
      const profile = await source.read();
      if (profile?.active && !await sourceController.isCurrentSelection()) { requiresSourceReview = true; return { kind: 'sourceReview' as const }; }
      requiresSourceReview = false;
      const zone = port.timeZone(); const today = sharedLocalDate(new Date(now()), zone);
      return capture.capture({ range: createCalendarQueryRange(today, addDays(today, 180), zone), force: true });
    }
    const key = await secrets.currentKey(userId, authority);
    try {
      if (!key) return { kind: 'awaitingKey' as const };
      const encrypted = await cloud.readCache(authority); if (!encrypted) return { kind: 'missing' as const };
      await cache.save(encrypted, { authority, accountKey: key, calendarBinding: privateCalendarSourceBinding(authority), origin: 'remote' }); await port.assertOwner();
      return { kind: 'received' as const, sequence: encrypted.manifest.body.sequence };
    } finally { key?.fill(0); }
  }
  return { readSettings, readForPlan, refreshData, invalidatePlaintext: invalidate,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async checkGoogleAccount() { await assertMain(); const account = await port.currentGoogleAccount(); await port.assertOwner(); return account; },
    async restoreCurrentGoogleAccount() {
      await assertMain(); if (!port.restoreGoogleAccount) throw new Error('この端末でGoogleログインを確認してください。');
      const account = await port.restoreGoogleAccount(); await port.assertOwner(); return account;
    },
    connectCurrentSource(subject: string, expectedAuthorityDigest: string) {
      return mutate(async () => { await assertMain(expectedAuthorityDigest); await port.authorizeGoogleSource(subject); await port.assertOwner();
        const result = await sourceController.change({ googleSubject: subject }, expectedAuthorityDigest); if (result.kind === 'ready') requiresSourceReview = false; return result; });
    },
    disableSource(expectedAuthorityDigest: string) { return mutate(async () => { await assertMain(expectedAuthorityDigest); return sourceController.change({ googleSubject: null }, expectedAuthorityDigest); }); },
    resumeSource: () => mutate(() => sourceController.resume()),
    dismissSource: (targetDigest: string, observedHeadDigest: string) => mutate(() => sourceController.dismissReviewed(targetDigest, observedHeadDigest)),
    async readOwnCalendar(target: DateTarget) {
      const calendar = await readForPlan(); await port.assertOwner();
      return calendar ? createPrivateCalendarReader(calendar.cache, calendar.binding, now())(target) : { kind: 'unknown' as const, reason: 'missing' as const };
    },
  };
}
export type PrivateCalendarRuntime = ReturnType<typeof createPrivateCalendarRuntime>;
