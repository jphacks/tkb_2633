export const GOOGLE_TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';
export const GOOGLE_TASKS_LIST_TITLE = '家事Planner';

export interface GoogleTaskList {
  id: string;
  title: string;
}

export interface GoogleTask {
  id: string;
  title: string;
  notes?: string;
  due?: string;
  status: 'needsAction' | 'completed';
  completed?: string;
  deleted?: boolean;
  hidden?: boolean;
}

export interface GoogleTaskDraft {
  title: string;
  due: string;
  notes?: string;
}

export interface GoogleTasksBatchTaskResult {
  requestId: string;
  ok: true;
  task: GoogleTask;
}

export interface GoogleTasksBatchTaskFailure {
  requestId: string;
  ok: false;
  status: number;
  code: string;
  retryAfter?: string;
}

export type GoogleTasksBatchItemResult = GoogleTasksBatchTaskResult | GoogleTasksBatchTaskFailure;

export interface GoogleTaskPatch {
  title?: string;
  due?: string;
  status?: 'needsAction' | 'completed';
  completed?: string | null;
  notes?: string;
}

export interface GoogleTaskUpdate {
  taskId: string;
  patch: GoogleTaskPatch;
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
  listTasks(accessToken: string, taskListId: string): Promise<GoogleTask[]>;
  getTask(accessToken: string, taskListId: string, taskId: string): Promise<GoogleTask>;
  createTask(accessToken: string, taskListId: string, draft: GoogleTaskDraft): Promise<GoogleTask>;
  createTasksBatch?(accessToken: string, taskListId: string, drafts: readonly GoogleTaskDraft[]): Promise<GoogleTasksBatchItemResult[]>;
  patchTasksBatch?(accessToken: string, taskListId: string, updates: readonly GoogleTaskUpdate[]): Promise<GoogleTasksBatchItemResult[]>;
  patchTask(accessToken: string, taskListId: string, taskId: string, patch: GoogleTaskPatch): Promise<GoogleTask>;
  deleteTask(accessToken: string, taskListId: string, taskId: string): Promise<void>;
}

const API_ROOT = 'https://tasks.googleapis.com/tasks/v1';
const BATCH_ROOT = 'https://tasks.googleapis.com/batch';
const REQUEST_TIMEOUT_MS = 20_000;
const BATCH_REQUEST_TIMEOUT_MS = 60_000;
export const GOOGLE_TASKS_BATCH_MAX_REQUESTS = 100;

export function createGoogleTasksApi(
  fetcher: typeof fetch = fetch,
  observeRequest?: (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', operationCount?: number) => void,
): GoogleTasksApi {
  const send = <T>(accessToken: string, path: string, init: RequestInit = {}) => {
    observeRequest?.((init.method ?? 'GET') as 'GET' | 'POST' | 'PATCH' | 'DELETE');
    return request<T>(fetcher, accessToken, path, init);
  };
  const sendBatch = async (accessToken: string, drafts: readonly {
    method: 'POST' | 'PATCH'; path: string; body: GoogleTaskDraft | GoogleTaskPatch;
  }[]): Promise<GoogleTasksBatchItemResult[]> => {
    if (drafts.length > GOOGLE_TASKS_BATCH_MAX_REQUESTS) {
      throw new RangeError(`Google Tasks batch cannot exceed ${GOOGLE_TASKS_BATCH_MAX_REQUESTS} requests`);
    }
    if (drafts.length === 0) return [];
    const boundary = createBatchBoundary();
    const operations = drafts.map((draft, index) => ({ ...draft, requestId: `request-${index}` }));
    const body = operations.map((operation) => [
      `--${boundary}`, 'Content-Type: application/http', `Content-ID: <${operation.requestId}>`, '',
      `${operation.method} ${operation.path} HTTP/1.1`, 'Content-Type: application/json; charset=UTF-8', '',
      JSON.stringify(operation.body),
    ].join('\r\n')).join('\r\n') + `\r\n--${boundary}--\r\n`;
    observeRequest?.('POST', drafts.length);
    return requestBatch(fetcher, accessToken, body, boundary, operations.map(({ requestId }) => requestId));
  };
  return {
    async listTaskLists(accessToken) {
      const items: GoogleTaskList[] = [];
      const visitedTokens = new Set<string>();
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({ maxResults: '100' });
        if (pageToken) params.set('pageToken', pageToken);
        const page = await send<{ items?: GoogleTaskList[]; nextPageToken?: string }>(
          accessToken, `/users/@me/lists?${params.toString()}`,
        );
        items.push(...(page.items ?? []));
        pageToken = page.nextPageToken;
        if (pageToken && visitedTokens.has(pageToken)) throw new Error('Google Tasks returned a repeated page token');
        if (pageToken) visitedTokens.add(pageToken);
      } while (pageToken);
      return items;
    },

    createTaskList(accessToken, title) {
      return send(accessToken, '/users/@me/lists', {
        method: 'POST',
        body: JSON.stringify({ title }),
      });
    },

    async listTasks(accessToken, taskListId) {
      const items: GoogleTask[] = [];
      const visitedTokens = new Set<string>();
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({ maxResults: '100', showCompleted: 'true', showHidden: 'true', showDeleted: 'true' });
        if (pageToken) params.set('pageToken', pageToken);
        const page = await send<{ items?: GoogleTask[]; nextPageToken?: string }>(
          accessToken, `/lists/${encodeURIComponent(taskListId)}/tasks?${params.toString()}`,
        );
        items.push(...(page.items ?? []));
        pageToken = page.nextPageToken;
        if (pageToken && visitedTokens.has(pageToken)) throw new Error('Google Tasks returned a repeated page token');
        if (pageToken) visitedTokens.add(pageToken);
      } while (pageToken);
      return items;
    },

    getTask(accessToken, taskListId, taskId) {
      return send(accessToken, `/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`);
    },

    createTask(accessToken, taskListId, draft) {
      return send(accessToken, `/lists/${encodeURIComponent(taskListId)}/tasks`, {
        method: 'POST',
        body: JSON.stringify(draft),
      });
    },

    async createTasksBatch(accessToken, taskListId, drafts) {
      return sendBatch(accessToken, drafts.map((draft) => ({
        method: 'POST',
        path: `/tasks/v1/lists/${encodeURIComponent(taskListId)}/tasks`,
        body: draft,
      })));
    },

    async patchTasksBatch(accessToken, taskListId, updates) {
      return sendBatch(accessToken, updates.map(({ taskId, patch }) => ({
        method: 'PATCH',
        path: `/tasks/v1/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`,
        body: patch,
      })));
    },

    patchTask(accessToken, taskListId, taskId, patch) {
      return send(accessToken, `/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
    },

    async deleteTask(accessToken, taskListId, taskId) {
      await send<void>(accessToken, `/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`, {
        method: 'DELETE',
      });
    },
  };
}

function createBatchBoundary(): string {
  return `housework_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
}

async function requestBatch(
  fetcher: typeof fetch,
  accessToken: string,
  body: string,
  boundary: string,
  requestIds: readonly string[],
): Promise<GoogleTasksBatchItemResult[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BATCH_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetcher(BATCH_ROOT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/mixed; boundary=${boundary}`,
      },
      body,
    });
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      throw new GoogleTasksApiError(
        response.status,
        googleErrorCode(payload) ?? `http_${response.status}`,
        response.headers.get('Retry-After'),
      );
    }
    const responseBoundary = multipartBoundary(response.headers.get('Content-Type'));
    if (!responseBoundary) throw new GoogleTasksApiError(502, 'invalid_batch_response', null);
    const parts = parseBatchResponse(await response.text(), responseBoundary);
    const resultByRequestId = new Map(parts.map((part) => [part.requestId, part]));
    return requestIds.map((requestId) => {
      const part = resultByRequestId.get(requestId);
      if (!part) return { requestId, ok: false, status: 502, code: 'missing_batch_response' };
      if (part.status < 200 || part.status >= 300) {
        return { requestId, ok: false, status: part.status, code: part.code ?? `http_${part.status}`,
          ...(part.retryAfter ? { retryAfter: part.retryAfter } : {}) };
      }
      if (!part.body) return { requestId, ok: false, status: 502, code: 'missing_batch_task' };
      try {
        const task = JSON.parse(part.body) as GoogleTask;
        if (!task.id) return { requestId, ok: false, status: 502, code: 'missing_batch_task_id' };
        return { requestId, ok: true, task };
      } catch {
        return { requestId, ok: false, status: 502, code: 'invalid_batch_task' };
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

function multipartBoundary(contentType: string | null): string | null {
  const match = contentType?.match(/(?:^|;)\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/iu);
  return match?.[1] ?? match?.[2] ?? null;
}

function parseBatchResponse(body: string, boundary: string): {
  requestId: string;
  status: number;
  code?: string;
  retryAfter?: string;
  body?: string;
}[] {
  return body.split(`--${boundary}`).flatMap((rawPart) => {
    const part = rawPart.trim();
    if (!part || part === '--') return [];
    const partSeparator = part.indexOf('\r\n\r\n');
    if (partSeparator < 0) return [];
    const headers = part.slice(0, partSeparator);
    const contentId = headers.match(/^Content-ID:\s*<?(?:response-)?([^>\r\n]+)>?\s*$/imu)?.[1];
    const requestId = contentId?.replace(/^response-/u, '');
    if (!requestId) return [];
    const response = part.slice(partSeparator + 4).trim();
    const statusMatch = response.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\b[^\r\n]*(?:\r?\n|$)/u);
    if (!statusMatch) return [];
    const status = Number(statusMatch[1]);
    const responseHeaderSeparator = response.indexOf('\r\n\r\n');
    const retryAfter = responseHeaderSeparator < 0 ? undefined
      : response.slice(0, responseHeaderSeparator).match(/^Retry-After:\s*(.+)\r?$/imu)?.[1]?.trim();
    const responseBody = responseHeaderSeparator >= 0 ? response.slice(responseHeaderSeparator + 4).trim() : '';
    let code: string | undefined;
    if (responseBody) {
      try {
        code = googleErrorCode(JSON.parse(responseBody));
      } catch { /* A non-JSON body still has its HTTP status. */ }
    }
    return [{ requestId, status, ...(code ? { code } : {}), ...(retryAfter ? { retryAfter } : {}),
      ...(responseBody ? { body: responseBody } : {}) }];
  });
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
      const payload: unknown = await response.json().catch(() => null);
      throw new GoogleTasksApiError(
        response.status,
        googleErrorCode(payload) ?? `http_${response.status}`,
        response.headers.get('Retry-After'),
      );
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

function googleErrorCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || !('error' in payload)) return undefined;
  const error = payload.error;
  if (!error || typeof error !== 'object') return undefined;
  // Google also uses HTTP 403 for quota limits. Preserve its structured reason
  // so those failures are not mistaken for a missing OAuth permission.
  if ('errors' in error && Array.isArray(error.errors)) {
    for (const detail of error.errors) {
      if (detail && typeof detail === 'object' && 'reason' in detail && typeof detail.reason === 'string') {
        return detail.reason;
      }
    }
  }
  if ('status' in error && typeof error.status === 'string') return error.status;
  if ('code' in error && (typeof error.code === 'string' || typeof error.code === 'number')) return String(error.code);
  return undefined;
}
