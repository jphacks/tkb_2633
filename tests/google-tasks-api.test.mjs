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

test('Google Tasks inserts are sent in multipart batches of at most 100 and matched by Content-ID', async () => {
  let observed;
  const api = createGoogleTasksApi(async (url, init) => {
    observed = { url: String(url), init };
    const requestBody = String(init.body);
    assert.match(requestBody, /POST \/tasks\/v1\/lists\/list%2F1\/tasks HTTP\/1\.1/u);
    assert.equal((requestBody.match(/Content-ID: <request-/gu) ?? []).length, 2);
    const responseBody = [
      '--response-boundary',
      'Content-Type: application/http',
      'Content-ID: <response-request-1>',
      '',
      'HTTP/1.1 201 Created',
      'Content-Type: application/json',
      '',
      JSON.stringify({ id: 'task-1', title: '二番目', status: 'needsAction' }),
      '--response-boundary',
      'Content-Type: application/http',
      'Content-ID: <response-request-0>',
      '',
      'HTTP/1.1 201 Created',
      'Content-Type: application/json',
      '',
      JSON.stringify({ id: 'task-0', title: '一番目', status: 'needsAction' }),
      '--response-boundary--',
      '',
    ].join('\r\n');
    return new Response(responseBody, { status: 200, headers: { 'Content-Type': 'multipart/mixed; boundary="response-boundary"' } });
  });

  const results = await api.createTasksBatch('token', 'list/1', [
    { title: '一番目', due: '2026-10-26T00:00:00.000Z' },
    { title: '二番目', due: '2026-10-27T00:00:00.000Z' },
  ]);
  assert.equal(observed.url, 'https://tasks.googleapis.com/batch');
  assert.equal(observed.init.headers.Authorization, 'Bearer token');
  assert.match(observed.init.headers['Content-Type'], /^multipart\/mixed; boundary=housework_/u);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].task.id, 'task-0');
  assert.equal(results[1].ok, true);
  assert.equal(results[1].task.id, 'task-1');
});

test('Google Tasks rejects batches larger than 100 before making a request', async () => {
  let calls = 0;
  const api = createGoogleTasksApi(async () => { calls += 1; return Response.json({}); });
  await assert.rejects(api.createTasksBatch('token', 'list', Array.from({ length: 101 }, (_, index) => ({
    title: `Task ${index}`, due: '2026-10-26T00:00:00.000Z',
  }))), RangeError);
  assert.equal(calls, 0);
  await assert.rejects(api.patchTasksBatch('token', 'list', Array.from({ length: 101 }, (_, index) => ({
    taskId: `Task ${index}`, patch: { status: 'needsAction' },
  }))), RangeError);
  assert.equal(calls, 0);
});

test('Google Tasks update batches encode stable IDs and retain Retry-After on per-item errors', async () => {
  const observed = [];
  const counts = [];
  const api = createGoogleTasksApi(async (url, init) => {
    observed.push({ url: String(url), body: String(init.body) });
    return new Response([
      '--updates', 'Content-Type: application/http', 'Content-ID: <response-request-1>', '',
      'HTTP/1.1 429 Too Many Requests', 'Retry-After: 3600', 'Content-Type: application/json', '',
      JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } }),
      '--updates', 'Content-Type: application/http', 'Content-ID: <response-request-0>', '',
      'HTTP/1.1 200 OK', 'Content-Type: application/json', '',
      JSON.stringify({ id: 'task/1', title: '家事', due: '2026-11-30T00:00:00.000Z', status: 'needsAction' }),
      '--updates--', '',
    ].join('\r\n'), { status: 200, headers: { 'Content-Type': 'multipart/mixed; boundary=updates' } });
  }, (method, operations) => counts.push({ method, operations }));
  const result = await api.patchTasksBatch('token', 'list/1', [
    { taskId: 'task/1', patch: { due: '2026-11-30T00:00:00.000Z' } },
    { taskId: 'task/2', patch: { status: 'completed', completed: '2026-10-26T01:00:00.000Z' } },
  ]);
  assert.match(observed[0].body, /PATCH \/tasks\/v1\/lists\/list%2F1\/tasks\/task%2F1 HTTP\/1\.1/u);
  assert.equal(result[0].task.id, 'task/1');
  assert.deepEqual(result[1], { requestId: 'request-1', ok: false, status: 429, code: 'RESOURCE_EXHAUSTED', retryAfter: '3600' });
  assert.deepEqual(counts, [{ method: 'POST', operations: 2 }]);
});

test('Google Tasks batch results preserve per-item failures alongside successful creates', async () => {
  const responseBody = [
    '--partial-boundary',
    'Content-Type: application/http',
    'Content-ID: <response-request-0>',
    '',
    'HTTP/1.1 201 Created',
    'Content-Type: application/json',
    '',
    JSON.stringify({ id: 'created-task', title: '成功', status: 'needsAction' }),
    '--partial-boundary',
    'Content-Type: application/http',
    'Content-ID: <response-request-1>',
    '',
    'HTTP/1.1 403 Forbidden',
    'Content-Type: application/json',
    '',
    JSON.stringify({ error: { status: 'PERMISSION_DENIED' } }),
    '--partial-boundary--',
    '',
  ].join('\r\n');
  const api = createGoogleTasksApi(async () => new Response(responseBody, {
    status: 200,
    headers: { 'Content-Type': 'multipart/mixed; boundary=partial-boundary' },
  }));

  const results = await api.createTasksBatch('token', 'list', [
    { title: '成功', due: '2026-10-26T00:00:00.000Z' },
    { title: '失敗', due: '2026-10-26T00:00:00.000Z' },
  ]);

  assert.deepEqual(results[0], { requestId: 'request-0', ok: true, task: { id: 'created-task', title: '成功', status: 'needsAction' } });
  assert.deepEqual(results[1], { requestId: 'request-1', ok: false, status: 403, code: 'PERMISSION_DENIED' });
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

test('Google Tasks retains the quota reason from HTTP 403 in direct, batch envelope and batch item errors', async () => {
  const payload = { error: { code: 403, status: 'PERMISSION_DENIED', errors: [{ reason: 'quotaExceeded' }], message: 'private detail' } };
  const api = createGoogleTasksApi(async () => Response.json(payload, { status: 403 }));
  for (const operation of [
    () => api.listTaskLists('token'),
    () => api.createTasksBatch('token', 'list', [{ title: '家事', due: '2026-10-26T00:00:00.000Z' }]),
  ]) {
    await assert.rejects(operation, (error) => error.status === 403 && error.code === 'quotaExceeded' && !error.message.includes('private detail'));
  }
  const batchApi = createGoogleTasksApi(async () => new Response([
    '--quota', 'Content-Type: application/http', 'Content-ID: <response-request-0>', '',
    'HTTP/1.1 403 Forbidden', 'Content-Type: application/json', '', JSON.stringify(payload), '--quota--', '',
  ].join('\r\n'), { status: 200, headers: { 'Content-Type': 'multipart/mixed; boundary=quota' } }));
  const results = await batchApi.patchTasksBatch('token', 'list', [{ taskId: 'task', patch: { status: 'completed' } }]);
  assert.deepEqual(results, [{ requestId: 'request-0', ok: false, status: 403, code: 'quotaExceeded' }]);
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

test('tasklists.list rejects repeated page tokens before a third HTTP request', async () => {
  let calls = 0;
  const api = createGoogleTasksApi(async () => { if (++calls > 2) throw new Error('fixture detected an unbounded read'); return Response.json({ nextPageToken: 'same' }); });
  await assert.rejects(api.listTaskLists('test-token'), /repeated page token/u); assert.equal(calls, 2);
});
