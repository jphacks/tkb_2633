export interface PlannerRefreshOptions {
  waitForWeather?: boolean;
  widgetCompletionIds?: readonly string[];
  force?: boolean;
}

export interface PlannerViewState<Snapshot> {
  snapshot: Snapshot | null;
  loading: boolean;
  error: string | null;
}

/** One shared refresh queue per provider. Screens only subscribe to the resulting snapshot. */
export function createPlannerRefreshController<Snapshot>(dependencies: {
  load(widgetIds: readonly string[], force: boolean): Promise<{ snapshot: Snapshot; canPublishWidget: boolean }>;
  weather(snapshot: Snapshot, canCommit: () => boolean): Promise<Snapshot | null>;
  publish(snapshot: Snapshot, canPublishWidget: boolean): void | Promise<void>;
  discardSnapshotOnError?: (error: unknown) => boolean;
}) {
  let state: PlannerViewState<Snapshot> = { snapshot: null, loading: true, error: null };
  const listeners = new Set<() => void>();
  let revision = 0;
  let requested: { ids: Set<string>; waitForWeather: boolean; force: boolean } | null = null;
  let running: Promise<void> | null = null;
  let lastCanPublishWidget: boolean | undefined;

  const update = (next: PlannerViewState<Snapshot>) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const publish = (snapshot: Snapshot, canPublishWidget: boolean) => {
    if (state.snapshot === snapshot && !state.loading && state.error === null && lastCanPublishWidget === canPublishWidget) return;
    lastCanPublishWidget = canPublishWidget;
    update({ snapshot, loading: false, error: null });
    // Native side effects never turn a successful database read into a screen failure.
    const failed = () => {
      if (state.snapshot === snapshot && lastCanPublishWidget === canPublishWidget) lastCanPublishWidget = undefined;
    };
    try {
      const pending = dependencies.publish(snapshot, canPublishWidget);
      if (pending) void Promise.resolve(pending).catch(failed);
    } catch { failed(); }
  };
  const drain = async () => {
    while (requested) {
      const request = requested;
      requested = null;
      const current = revision;
      try {
        const result = await dependencies.load([...request.ids], request.force);
        if (current !== revision) continue;
        publish(result.snapshot, result.canPublishWidget);
        const weather = dependencies.weather(result.snapshot, () => current === revision).then((snapshot) => {
          if (snapshot && current === revision) publish(snapshot, result.canPublishWidget);
        }).catch((error: unknown) => {
          if (current === revision) update({ ...state, error: error instanceof Error ? error.message : '天気に合わせて予定を保存できませんでした' });
        });
        if (request.waitForWeather) await weather;
      } catch (error) {
        if (current === revision) update({ ...state, ...(dependencies.discardSnapshotOnError?.(error) ? { snapshot: null } : {}), loading: false,
          error: error instanceof Error ? error.message : 'データを読み込めませんでした' });
      }
    }
  };
  const schedule = (): Promise<void> => {
    running ??= Promise.resolve().then(drain).finally(() => {
      running = null;
      if (requested) return schedule();
    });
    return running;
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh(options: PlannerRefreshOptions = {}): Promise<void> {
      revision += 1;
      requested ??= { ids: new Set(), waitForWeather: false, force: false };
      for (const id of options.widgetCompletionIds ?? []) requested.ids.add(id);
      requested.waitForWeather ||= options.waitForWeather === true;
      requested.force ||= options.force === true || Boolean(options.widgetCompletionIds?.length);
      return schedule();
    },
    invalidate() { revision += 1; },
  };
}
