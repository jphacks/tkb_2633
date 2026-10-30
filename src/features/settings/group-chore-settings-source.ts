import { createPlannerRefreshController } from '../planner/refresh-controller.ts';
import { loadPlannerSnapshot, setChoresEnabled } from '../../platform/storage/repository.ts';
import type { PlannerSnapshot } from '../../platform/storage/repository';
import type { SharedWorkspace } from '../../platform/sharing/workspace-types';
import type { SharingSelection } from '../sharing/workspace-selection';
import type { SharingWorkspaceRecord } from '../../platform/storage/sharing-registry';
import { createV2ScreenSession } from '../sharing/v2-ui/screen-session.ts';
import type { V2GroupScreenModel } from '../sharing/v2/controller';
import { validateChoreToggle } from '../../domain/chores/chore-groups.ts';

export type GroupChoreSettingsValue = { workspace: SharedWorkspace; record: SharingWorkspaceRecord } & (
  { protocol: 1; snapshot: PlannerSnapshot } | { protocol: 2; model: V2GroupScreenModel }
);

/** Reads a named group without selecting it or starting another planner/Google/background worker. */
export function createGroupChoreSettingsSource(selection: SharingSelection, open: (selection: SharingSelection) => Promise<SharedWorkspace>) {
  let generation: string | undefined;
  const authorize = async () => {
    const workspace = await open(selection);
    if (workspace.userId !== selection.userId || workspace.groupId !== selection.groupId || workspace.protocol === null) throw new Error('共有グループを確認してください。');
    const record = await workspace.record();
    if (record.userId !== selection.userId || record.groupId !== selection.groupId || !['active', 'creating'].includes(record.status)
      || (generation !== undefined && generation !== record.localGeneration)) throw new Error('グループの参加状態が変わりました。設定を開き直してください。');
    generation = record.localGeneration;
    return { workspace, record };
  };
  const controller = createPlannerRefreshController<GroupChoreSettingsValue>({
    discardSnapshotOnError: () => true,
    load: async () => {
      const { workspace, record } = await authorize();
      const value: GroupChoreSettingsValue = workspace.protocol === 1
        ? { workspace, record, protocol: 1, snapshot: await loadPlannerSnapshot(workspace.database) }
        : { workspace, record, protocol: 2, model: await createV2SettingsSession(workspace).readModel({ management: true }) };
      await authorize();
      return { snapshot: value, canPublishWidget: false };
    },
    weather: async () => null, publish: () => {},
  });
  return { ...controller,
    async saveEnabled(ids: string[], enabled: boolean) {
      validateChoreToggle(ids, enabled);
      const { workspace } = await authorize();
      if (workspace.protocol === 1) await setChoresEnabled(workspace.database, ids, enabled);
      else {
        // v2 currently has a single-chore command. Never turn a category tap into partial writes.
        if (ids.length !== 1) throw new Error('共有家事は一件ずつ切り替えてください。');
        if (workspace.roster()?.body.ownerUserId !== selection.userId) throw new Error('有効・無効はグループの管理者が変更できます。');
        await workspace.session.controller.actions.patchChore(ids[0], { enabled });
      }
      await controller.refresh();
      return { refreshed: !controller.getSnapshot().error };
    },
  };
}

/** Management must not read personal availability, Google tokens, or overlay/history data. */
export function createV2SettingsSession(workspace: Extract<SharedWorkspace, { protocol: 2 }>) {
  return createV2ScreenSession({ controller: { ...workspace.session.controller, sync: () => workspace.sync({ force: true }) },
    groupId: workspace.groupId, userId: workspace.userId, now: () => new Date(),
    readPreferences: () => { throw new Error('家事設定では個人の時間帯を読み取りません。'); } });
}
