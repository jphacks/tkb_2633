export const GOOGLE_TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';
export const GOOGLE_TASKS_LIST_TITLE = '家事Planner';

export interface GoogleTaskList {
  id: string;
  title: string;
}

export interface GoogleTask {
  id: string;
  title: string;
  due?: string;
  status: 'needsAction' | 'completed';
  completed?: string;
  deleted?: boolean;
}

export interface GoogleTaskDraft {
  title: string;
  due: string;
}

export interface GoogleTaskPatch {
  title?: string;
  due?: string;
  status?: 'completed';
  completed?: string;
}

export class GoogleTasksApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter: string | null;

  constructor(status: number, code: string, retryAfter: string | null) {
    super(`Google Tasks request failed (${status})`);
    this.name = 'GoogleTasksApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export class GoogleTaskNotFoundError extends Error {
  constructor() {
    super('Google Task was not found');
    this.name = 'GoogleTaskNotFoundError';
  }
}

export interface GoogleTasksApi {
  listTaskLists(accessToken: string): Promise<GoogleTaskList[]>;
  createTaskList(accessToken: string, title: string): Promise<GoogleTaskList>;
  getTask(accessToken: string, taskListId: string, taskId: string): Promise<GoogleTask>;
  createTask(accessToken: string, taskListId: string, draft: GoogleTaskDraft): Promise<GoogleTask>;
  patchTask(accessToken: string, taskListId: string, taskId: string, patch: GoogleTaskPatch): Promise<GoogleTask>;
  deleteTask(accessToken: string, taskListId: string, taskId: string): Promise<void>;
}

const API_ROOT = 'https://tasks.googleapis.com/tasks/v1';
const REQUEST_TIMEOUT_MS = 20_000;

export function createGoogleTasksApi(fetcher: typeof fetch = fetch): GoogleTasksApi {
  return {
    async listTaskLists(accessToken) {
      const items: GoogleTaskList[] = [];
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({ maxResults: '100' });
        if (pageToken) params.set('pageToken', pageToken);
        const page = await request<{ items?: GoogleTaskList[]; nextPageToken?: string }>(
          fetcher, accessToken, `/users/@me/lists?${params.toString()}`,
        );
        items.push(...(page.items ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken);
      return items;
    },

    createTaskList(accessToken, title) {
      return request(fetcher, accessToken, '/users/@me/lists', {
        method: 'POST',
        body: JSON.stringify({ title }),
      });
    },

    getTask(accessToken, taskListId, taskId) {
      return request(fetcher, accessToken, `/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`);
    },

    createTask(accessToken, taskListId, draft) {
      return request(fetcher, accessToken, `/lists/${encodeURIComponent(taskListId)}/tasks`, {
        method: 'POST',
        body: JSON.stringify(draft),
      });
    },

    patchTask(accessToken, taskListId, taskId, patch) {
      return request(fetcher, accessToken, `/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
    },

    async deleteTask(accessToken, taskListId, taskId) {
      await request<void>(fetcher, accessToken, `/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`, {
        method: 'DELETE',
      });
    },
  };
}

async function request<T>(
  fetcher: typeof fetch,
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetcher(`${API_ROOT}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    if (response.status === 404) throw new GoogleTaskNotFoundError();
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { status?: string; code?: string } } | null;
      throw new GoogleTasksApiError(
        response.status,
        payload?.error?.status ?? payload?.error?.code ?? `http_${response.status}`,
        response.headers.get('Retry-After'),
      );
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}
