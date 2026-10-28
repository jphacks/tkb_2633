import type { V2GoogleTaskStore } from '../../../platform/storage/sharing-v2-google-tasks';
import type { GoogleTasksApi } from '../../../platform/google-tasks/google-tasks-api';
import type { GoogleSyncState } from '../../google-sync/contracts';
import { withGoogleSyncOperation } from '../../google-sync/operation-lock.ts';
import { syncGoogleTasksWithDependencies } from '../../google-sync/coordinator';
import type { GoogleSyncCoordinatorDependencies, GoogleSyncRunResult } from '../../google-sync/coordinator';
import { createGoogleOperationBudget } from '../../google-sync/operation-budget.ts';
import type { GoogleOperationBudget } from '../../google-sync/operation-budget';
import { GoogleAccountMismatchError } from '../../google-sync/account-binding.ts';

export interface V2GoogleConnectionReview { subject: string; label: string; connectionRevision: number }
export function createV2GoogleTaskRuntime(input: { store: V2GoogleTaskStore; assertAccess(): void | Promise<void>;
  restoreAccount(): Promise<{ subject: string; label: string }>; currentSubject(): Promise<string | null>; authorizeTasks(): Promise<void>; token(subject: string): Promise<string>;
  createApi(context: { budget: GoogleOperationBudget; assertCurrent(): Promise<void> }): GoogleTasksApi;
  preparePlan?(): Promise<void>; now?: () => Date; budgetNow?: () => number; onImported?(): void | Promise<void> }) {
  const now = input.now ?? (() => new Date()); const scope = {}; let action: Promise<unknown> | null = null;
  let running: { promise: Promise<GoogleSyncRunResult>; budget: GoogleOperationBudget; force: boolean } | null = null;
  let requested = false; let forceRequested = false;
  function mutate<T>(work: () => Promise<T>): Promise<T> {
    if (action) return Promise.reject(new Error('Google家事の接続操作が終わるまでお待ちください。'));
    const pending = withGoogleSyncOperation(async () => { await input.assertAccess(); const value = await work(); await input.assertAccess(); return value; }); action = pending;
    void pending.finally(() => { if (action === pending) action = null; }).catch(() => undefined); return pending;
  }
  async function run(force: boolean, budget: GoogleOperationBudget): Promise<GoogleSyncRunResult> {
    let revision: number | undefined; let boundSubject: string | undefined;
    const assertBinding = async (checkTime = true) => {
      if (checkTime) budget.assert(); await input.assertAccess(); const control = await input.store.readControl();
      if (control.revision !== revision || !control.state?.enabled || control.state.disconnected || control.state.accountSubject !== boundSubject) throw new GoogleAccountMismatchError();
      await input.assertAccess(); if (checkTime) budget.assert();
    };
    const assertSession = async () => { await assertBinding(); if (await input.currentSubject() !== boundSubject) throw new GoogleAccountMismatchError(); budget.assert(); };
    const context = { budget, assertCurrent: assertSession }; const api = input.createApi(context);
    const guarded = Object.fromEntries(Object.entries(api).map(([key, method]) => [key, async (...args: unknown[]) => {
      await assertSession(); const result = await Reflect.apply(method, api, args); await assertSession(); return result;
    }])) as unknown as GoogleTasksApi;
    const port = input.store.port;
    const dependencies: GoogleSyncCoordinatorDependencies = {
      ...port, syncScope: scope,
      loadState: async () => {
        await input.assertAccess(); const value = await input.store.readControl(); revision = value.revision; boundSubject = value.state?.accountSubject;
        if (value.state?.enabled && !value.state.disconnected) {
          budget.assert(); await input.preparePlan?.(); await assertBinding();
          dependencies.today = await input.store.readToday(); await assertBinding();
        }
        return value.state;
      },
      saveState: async (state: GoogleSyncState) => { await input.assertAccess(); if (revision === undefined) throw new Error('Google家事の接続を読み直してください。'); await input.store.saveSyncState(state, revision); },
      hasPendingLocalChanges: input.store.hasPendingLocalChanges,
      getAccessToken: async () => {
        await assertBinding(); if (await input.currentSubject() !== boundSubject) throw new GoogleAccountMismatchError();
        await assertBinding(); const token = await input.token(boundSubject!);
        await assertBinding(); if (await input.currentSubject() !== boundSubject) throw new GoogleAccountMismatchError(); return token;
      },
      importGoogleTaskChanges: async (...args: Parameters<typeof port.importGoogleTaskChanges>) => {
        await assertSession(); const count = await port.importGoogleTaskChanges(...args);
        if (count) try { await input.onImported?.(); } catch { /* Signed facts and private mapping have already committed together. */ }
        return count;
      },
      api: guarded,
    };
    let result: GoogleSyncRunResult = { kind: 'success', skipped: true };
    for (let pass = 0; pass < 3; pass++) {
      requested = false; const nextForce = force || forceRequested; forceRequested = false;
      result = await syncGoogleTasksWithDependencies(dependencies, { now: now(), force: nextForce, forceCalendar: false, recoverInterruptedAttempt: true });
      if (!requested || result.kind !== 'success') return result;
      budget.assert();
    }
    return result;
  }
  return { store: input.store,
    readControl: () => input.store.readControl(),
    reviewConnection: () => mutate(async (): Promise<V2GoogleConnectionReview> => {
      const before = await input.store.readControl(); const account = await input.restoreAccount(); await input.assertAccess();
      if (before.state?.accountSubject && before.state.accountSubject !== account.subject) throw new GoogleAccountMismatchError();
      const after = await input.store.readControl(); if (after.revision !== before.revision) throw new Error('Google家事の接続が変わりました。もう一度確認してください。');
      return { ...account, connectionRevision: before.revision };
    }),
    connect: (review: V2GoogleConnectionReview) => {
      const expected = { ...review };
      return mutate(async () => {
        if (await input.currentSubject() !== expected.subject) throw new GoogleAccountMismatchError();
        const before = await input.store.readControl(); if (before.revision !== expected.connectionRevision) throw new Error('Google家事の接続が変わりました。もう一度確認してください。');
        await input.authorizeTasks(); await input.assertAccess();
        if (await input.currentSubject() !== expected.subject) throw new GoogleAccountMismatchError();
        return input.store.configure(expected.connectionRevision, expected, true);
      });
    },
    pause: (expectedRevision: number, disconnect = false) => {
      running?.budget.cancel();
      return mutate(async () => {
        const control = await input.store.readControl(); if (!control.state?.accountSubject || control.revision !== expectedRevision) throw new Error('Google家事の接続を読み直してください。');
        return input.store.configure(expectedRevision, { subject: control.state.accountSubject, label: control.label! }, false, disconnect);
      });
    },
    synchronize(options: { force?: boolean; budgetMs?: number; localChange?: boolean } = {}) {
      const milliseconds = options.budgetMs ?? (options.force ? 100_000 : 15_000);
      if (running) {
        running.budget.shrink(milliseconds);
        if (options.localChange || options.force && !running.force) { requested = true; forceRequested ||= options.force === true; }
        return running.promise;
      }
      const budget = createGoogleOperationBudget(milliseconds, input.budgetNow);
      const operation = run(options.force === true, budget);
      const promise = Promise.race([operation, budget.expiration.then((): GoogleSyncRunResult => ({ kind: 'retry', code: 'timeout' }))]);
      running = { promise, budget, force: options.force === true };
      void operation.finally(() => { budget.close(); if (running?.promise === promise) running = null; }).catch(() => undefined);
      return promise;
    },
  };
}
export type V2GoogleTaskRuntime = ReturnType<typeof createV2GoogleTaskRuntime>;
