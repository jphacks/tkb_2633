import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/typescript-loader.mjs';

const { createGoogleTasksApi, GoogleTaskNotFoundError, GoogleTasksApiError } = await import('../src/platform/google-tasks/google-tasks-api.ts');

test('Google Tasks API paginates task lists and sends the access token only in the authorization header', async () => {
  const calls = [];
  const api = createGoogleTasksApi(async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return Response.json({ items: [{ id: 'list-1', title: '家事Planner' }], nextPageToken: 'next' });
    return Response.json({ items: [{ id: 'list-2', title: 'Other' }] });
  });

  const lists = await api.listTaskLists('access-token-secret');
  assert.deepEqual(lists.map(({ id }) => id), ['list-1', 'list-2']);
  assert.match(calls[0].url, /users\/@me\/lists\?maxResults=100/u);
  assert.match(calls[1].url, /pageToken=next/u);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer access-token-secret');
  assert.equal(calls[0].url.includes('access-token-secret'), false);
});

test('Google Tasks API encodes IDs and sends date-only due timestamps', async () => {
  let observed;
  const api = createGoogleTasksApi(async (url, init) => {
    observed = { url: String(url), init };
    return Response.json({ id: 'task-1', title: '掃除', status: 'needsAction' });
  });

  await api.createTask('token', 'list/1', { title: '掃除', due: '2026-10-25T00:00:00.000Z' });
  assert.match(observed.url, /lists\/list%2F1\/tasks$/u);
  assert.deepEqual(JSON.parse(observed.init.body), { title: '掃除', due: '2026-10-25T00:00:00.000Z' });
});

test('Google Tasks API exposes safe status and Retry-After details without response body text', async () => {
  const api = createGoogleTasksApi(async () => new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'sensitive response detail' } }), {
    status: 429,
    headers: { 'Retry-After': '3600' },
  }));

  await assert.rejects(api.listTaskLists('token'), (error) => {
    assert.ok(error instanceof GoogleTasksApiError);
    assert.equal(error.status, 429);
    assert.equal(error.code, 'RESOURCE_EXHAUSTED');
    assert.equal(error.retryAfter, '3600');
    assert.equal(error.message.includes('sensitive response detail'), false);
    return true;
  });
});

test('Google Tasks API maps 404 to a not-found error', async () => {
  const api = createGoogleTasksApi(async () => new Response('', { status: 404 }));
  await assert.rejects(api.getTask('token', 'list', 'task'), GoogleTaskNotFoundError);
});

test('tasks.list reads 100 + 80 tasks, including a hidden completion on the final page', async () => {
  const calls = [];
  const tasks = Array.from({ length: 180 }, (_, index) => ({ id: `task-${index}`, title: '家事', status: 'needsAction' }));
  tasks[179] = { ...tasks[179], status: 'completed', hidden: true, completed: '2026-10-25T03:00:00Z' };
  const methods = [];
  const api = createGoogleTasksApi(async (url) => {
    const parsed = new URL(url);
    calls.push(parsed);
    return Response.json(parsed.searchParams.has('pageToken')
      ? { items: tasks.slice(100) }
      : { items: tasks.slice(0, 100), nextPageToken: 'page-two' });
  }, (method) => methods.push(method));
  const result = await api.listTasks('test-token', 'family/list');
  assert.equal(result.length, 180);
  assert.equal(result.at(-1).completed, tasks[179].completed);
  for (const url of calls) {
    assert.match(url.pathname, /family%2Flist\/tasks$/u);
    assert.equal(url.searchParams.get('maxResults'), '100');
    assert.equal(url.searchParams.get('showCompleted'), 'true');
    assert.equal(url.searchParams.get('showHidden'), 'true');
    assert.equal(url.searchParams.get('showDeleted'), 'true');
    assert.equal(url.searchParams.has('updatedMin'), false);
  }
  assert.equal(calls[1].searchParams.get('pageToken'), 'page-two');
  assert.deepEqual(methods, ['GET', 'GET']);
});

test('tasks.list rejects repeated page tokens instead of looping forever', async () => {
  let calls = 0;
  const api = createGoogleTasksApi(async () => { calls += 1; return Response.json({ nextPageToken: 'same' }); });
  await assert.rejects(api.listTasks('test-token', 'list'), /repeated page token/u);
  assert.equal(calls, 2);
});
