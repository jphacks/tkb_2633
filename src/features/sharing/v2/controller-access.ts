import type { V2GroupController } from './controller.ts';

/** Keep the command API intact while checking the live workspace before each user action. */
export function guardV2GroupController(controller: V2GroupController, authorize: (editing: boolean) => Promise<void>): V2GroupController {
  const actions = Object.fromEntries(Object.entries(controller.actions).map(([name, command]) => [name, async (...args: unknown[]) => {
    await authorize(true); return Reflect.apply(command, undefined, args);
  }])) as V2GroupController['actions'];
  return { ...controller, actions, readModel: async (range, readOptions) => { await authorize(false); return controller.readModel(range, readOptions); } };
}
