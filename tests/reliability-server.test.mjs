import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createApplianceCareHttpServer } from '../server/appliance-care-api/src/http-server.mjs';
import { fetchOfficialManualText, inspectOfficialManual, ManualFetchError } from '../server/appliance-care-api/src/manual-resolver.mjs';

const url = 'https://www.dyson.co.jp/support/manual';
const domains = ['dyson.co.jp'];
const htmlLimit = 2 * 1024 * 1024;
const validRequest = { manufacturer: 'Dyson', productName: 'V12', modelNumber: 'SV20' };

async function withServer(options, check) {
  const server = createApplianceCareHttpServer({ dependencies: {}, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await check(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); }
}

const post = (base, body, headers = {}) => fetch(`${base}/api/appliance-care/analyze`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
});

function streamedResponse({ bytes = 4 * 1024 * 1024, headers = {}, status = 200 } = {}) {
  const stats = { pulls: 0, readBytes: 0, cancelled: 0 };
  const body = new ReadableStream({
    pull(controller) {
      stats.pulls++;
      if (stats.readBytes === bytes) { controller.close(); return; }
      const size = Math.min(64 * 1024, bytes - stats.readBytes);
      stats.readBytes += size;
      controller.enqueue(new Uint8Array(size).fill(32));
    },
    cancel() { stats.cancelled++; },
  }, { highWaterMark: 0 });
  return { response: new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } }), stats };
}

for (const target of ['http://[', '//[', 'http://localhost:invalid/']) {
  test(`HTTP handler rejects malformed request target without an unhandled rejection: ${target}`, async () => {
    const server = createApplianceCareHttpServer({ dependencies: {} });
    const headers = new Map();
    const result = {};
    const response = {
      setHeader(key, value) { headers.set(key, value); },
      writeHead(status, values) { result.status = status; Object.entries(values).forEach(([key, value]) => headers.set(key, value)); },
      end(body) { result.body = JSON.parse(body); },
    };
    await assert.doesNotReject(() => server.listeners('request')[0]({ method: 'GET', url: target, headers: {} }, response));
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'INVALID_REQUEST');
    assert.equal(headers.get('x-content-type-options'), 'nosniff');
  });
}

for (const contentLength of [undefined, '1']) {
  test(`HTML manual stops reading at its byte limit with content-length=${contentLength}`, async () => {
    const { response, stats } = streamedResponse({ headers: contentLength ? { 'content-length': contentLength } : {} });
    await assert.rejects(fetchOfficialManualText({ url, kind: 'web_manual' }, domains, async () => response), ManualFetchError);
    assert.ok(stats.readBytes <= htmlLimit + 64 * 1024, `read ${stats.readBytes} bytes before refusing`);
    assert.equal(stats.cancelled, 1);
    assert.equal(response.body.locked, false);
  });
}

for (const headers of [{ 'content-length': String(htmlLimit + 1) }, { 'content-type': 'application/octet-stream' }]) {
  test(`HTML manual cancels a rejected response before reading: ${JSON.stringify(headers)}`, async () => {
    const { response, stats } = streamedResponse({ headers });
    await assert.rejects(fetchOfficialManualText({ url, kind: 'web_manual' }, domains, async () => response), ManualFetchError);
    assert.equal(stats.readBytes, 0);
    assert.equal(stats.cancelled, 1);
  });
}

for (const headers of [{ 'content-length': String(50 * 1024 * 1024 + 1) }, { 'content-type': 'image/png' }]) {
  test(`HEAD-to-GET manual inspection cancels invalid bodies: ${JSON.stringify(headers)}`, async () => {
    const fallback = streamedResponse({ headers });
    const methods = [];
    await assert.rejects(inspectOfficialManual(url, domains, async (_url, { method }) => {
      methods.push(method);
      return method === 'HEAD' ? new Response(null, { status: 405 }) : fallback.response;
    }), ManualFetchError);
    assert.deepEqual(methods, ['HEAD', 'GET']);
    assert.equal(fallback.stats.cancelled, 1);
    assert.equal(fallback.stats.readBytes, 0);
  });
}

test('HTML manual accepts the exact limit and preserves Japanese text and HTML cleanup', async () => {
  const text = '<script>secret</script><p>フィルターを洗う &amp; 乾かす</p><br>次の工程';
  const bytes = Buffer.from(text.padEnd(htmlLimit - Buffer.byteLength(text) + text.length));
  assert.equal(bytes.byteLength, htmlLimit);
  const result = await fetchOfficialManualText({ url, kind: 'web_manual' }, domains,
    async () => new Response(bytes, { headers: { 'content-type': 'application/xhtml+xml' } }));
  assert.equal(result.url, url);
  assert.equal(result.text, 'フィルターを洗う & 乾かす\n\n次の工程');
});

test('a malformed raw HTTP request does not prevent later health requests', async () => {
  await withServer({}, async (base) => {
    const status = await new Promise((resolve, reject) => {
      const request = httpRequest(`${base}/`, { path: 'http://[' }, (response) => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject); request.end();
    });
    assert.equal(status, 400);
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok', aiConfigured: true });
  });
});

test('HTTP origins and preflight preserve native requests and allow only configured origins', async () => {
  await withServer({ allowedOrigins: ['https://planner.example'] }, async (base) => {
    const rejected = await fetch(`${base}/health`, { headers: { origin: 'https://untrusted.example' } });
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).error.code, 'ORIGIN_NOT_ALLOWED');
    const allowed = await fetch(`${base}/health`, { headers: { origin: 'https://planner.example' } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://planner.example'); await allowed.json();
    const preflight = await fetch(`${base}/api/appliance-care/jobs`, { method: 'OPTIONS', headers: { origin: 'https://planner.example' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-headers'), 'content-type');
    const native = await fetch(`${base}/health`);
    assert.equal(native.status, 200);
    assert.equal(native.headers.get('access-control-allow-origin'), null); await native.json();
  });
});

for (const [label, body, headers, status] of [
  ['malformed JSON', '{', {}, 400],
  ['null JSON', 'null', {}, 400],
  ['array JSON', '[]', {}, 400],
  ['invalid force flag', JSON.stringify({ ...validRequest, forceReanalysis: 'true' }), {}, 400],
  ['non-JSON media type', JSON.stringify(validRequest), { 'content-type': 'text/plain' }, 415],
  ['large ASCII body', JSON.stringify({ ...validRequest, extra: 'x'.repeat(8192) }), {}, 413],
  ['large UTF8 body', JSON.stringify({ ...validRequest, extra: 'あ'.repeat(3000) }), {}, 413],
]) {
  test(`HTTP rejects ${label} before invoking analysis`, async () => {
    let analyzed = 0;
    await withServer({ dependencies: { resolveProduct() { analyzed++; throw new Error('must not run'); } } }, async (base) => {
      const response = await post(base, body, headers);
      assert.equal(response.status, status);
      assert.equal((await response.json()).code, 'INVALID_REQUEST');
      assert.equal(analyzed, 0);
    });
  });
}

test('HTTP address admission caps invalid retries without blocking health or status reads', async () => {
  await withServer({ aiConfigured: false }, async (base) => {
    for (let index = 0; index < 20; index++) {
      const response = await post(base, JSON.stringify(validRequest));
      assert.equal(response.status, 503); await response.json();
    }
    const limited = await post(base, JSON.stringify(validRequest));
    assert.equal(limited.status, 429); assert.equal((await limited.json()).code, 'RATE_LIMITED');
    const health = await fetch(`${base}/health`); assert.equal(health.status, 200); await health.json();
    for (const path of ['/not-found', '/api/appliance-care/jobs/00000000-0000-0000-0000-000000000000']) {
      const response = await fetch(base + path); assert.equal(response.status, 404); await response.json();
    }
  });
});

test('oversized chunked HTTP bodies are rejected and the connection remains usable', async () => {
  await withServer({}, async (base) => {
    const result = await new Promise((resolve, reject) => {
      const request = httpRequest(`${base}/api/appliance-care/analyze`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
      });
      request.on('error', reject);
      for (let index = 0; index < 5; index++) request.write(Buffer.alloc(2048, 32));
      request.end();
    });
    assert.equal(result.status, 413); assert.equal(result.body.code, 'INVALID_REQUEST');
    const health = await fetch(`${base}/health`); assert.equal(health.status, 200); await health.json();
  });
});

for (const status of [405, 501]) {
  test(`manual inspection falls back from HEAD ${status} to GET and releases both bodies`, async () => {
    const head = streamedResponse({ status });
    const get = streamedResponse({ headers: { 'content-type': 'application/pdf' } });
    const result = await inspectOfficialManual(url, domains, async (_url, { method }) => method === 'HEAD' ? head.response : get.response);
    assert.equal(result.kind, 'pdf');
    assert.equal(head.stats.cancelled, 1); assert.equal(get.stats.cancelled, 1);
    assert.equal(head.stats.readBytes + get.stats.readBytes, 0);
  });
}

test('manual redirects validate each destination and stop loops without retaining response bodies', async () => {
  const redirects = [];
  await assert.rejects(inspectOfficialManual(url, domains, async () => {
    const value = streamedResponse({ status: 302, headers: { location: '/support/manual' } });
    redirects.push(value); return value.response;
  }), ManualFetchError);
  assert.equal(redirects.length, 6);
  assert.ok(redirects.every(({ stats }) => stats.cancelled === 1 && stats.readBytes === 0));
  for (const destination of ['http://www.dyson.co.jp/manual', 'https://dyson.co.jp.attacker.example/manual', 'http://[', '']) {
    const value = streamedResponse({ status: 302, headers: destination ? { location: destination } : {} });
    let requests = 0;
    await assert.rejects(inspectOfficialManual(url, domains, async () => { requests++; return value.response; }), ManualFetchError);
    assert.equal(requests, 1); assert.equal(value.stats.cancelled, 1);
  }
});

test('a failed HTML body read releases its reader and a later request can succeed', async () => {
  const response = new Response(new ReadableStream({ pull(controller) { controller.error(new Error('synthetic read failure')); } }), { headers: { 'content-type': 'text/html' } });
  await assert.rejects(fetchOfficialManualText({ url, kind: 'web_manual' }, domains, async () => response), /synthetic read failure/);
  assert.equal(response.body.locked, false);
  assert.equal((await fetchOfficialManualText({ url, kind: 'web_manual' }, domains,
    async () => new Response('<p>再試行</p>', { headers: { 'content-type': 'text/html' } }))).text, '再試行');
});
