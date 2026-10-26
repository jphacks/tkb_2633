import type { SQLiteDatabase } from 'expo-sqlite';
import { bindGoogleSyncAccount, listGoogleTaskLinks, loadGoogleSyncState } from '../storage/repository';
import { GoogleAccountMismatchError, verifyGoogleAccountBinding } from '../../features/google-sync/account-binding.ts';
import { createGoogleTasksApi } from './google-tasks-api';
import { getCurrentGoogleSubject, getGoogleCalendarAccessToken, getGoogleTasksAccessToken, GoogleSignInRequiredError } from './google-sign-in-gateway';

/** Every workspace keeps its own binding; signing in to sharing cannot silently migrate private Google data. */
export async function getBoundGoogleAccessToken(database: SQLiteDatabase, purpose: 'tasks' | 'calendar'): Promise<string> {
  const state = await loadGoogleSyncState(database);
  const subject = await getCurrentGoogleSubject();
  if (!subject) throw new GoogleSignInRequiredError();
  if (state?.accountSubject && state.accountSubject !== subject) throw new GoogleAccountMismatchError();
  const token = purpose === 'tasks' ? await getGoogleTasksAccessToken(subject) : await getGoogleCalendarAccessToken(subject);
  if (state?.accountSubject) return token;
  const links = await listGoogleTaskLinks(database);
  const legacyLists = [...new Set([...(state?.taskListId ? [state.taskListId] : []), ...links.map((link) => link.googleTaskListId)])];
  await verifyGoogleAccountBinding({
    boundSubject: state?.accountSubject, currentSubject: subject, legacyTaskListIds: legacyLists,
    listOwnedTaskListIds: async () => {
      const tasksToken = purpose === 'tasks' ? token : await getGoogleTasksAccessToken(subject);
      const lists = await createGoogleTasksApi().listTaskLists(tasksToken);
      if (await getCurrentGoogleSubject() !== subject) throw new GoogleAccountMismatchError();
      return lists.map((list) => list.id);
    },
    persistSubject: (value) => bindGoogleSyncAccount(database, value),
  });
  return token;
}
