import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'react-native') return { url: 'data:text/javascript,export const Platform = { OS: "ios" };', shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { analyzeApplianceCareRequest } = await import('../src/features/appliance-care/api-client.ts');
const request = { manufacturer: 'Dyson', productName: 'V12', modelNumber: 'SV20' };

test('malformed API results are rejected before screens dereference them', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const payload of [
      { status: 'verified', product: null, officialSources: null, analysis: null },
      { status: 'ambiguous', candidates: [null] },
      { status: 'verified', product: request, officialSources: {}, analysis: { tasks: [null] } },
    ]) {
      globalThis.fetch = async () => Response.json(payload);
      const result = await analyzeApplianceCareRequest(request, 'https://api.example.test');
      assert.equal(result.status, 'error');
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('valid API errors retain their actionable message', async () => {
  const originalFetch = globalThis.fetch;
  try {
    const payload = { status: 'error', code: 'RATE_LIMITED', message: '少し待って再試行してください。' };
    globalThis.fetch = async () => Response.json(payload, { status: 429 });
    assert.deepEqual(await analyzeApplianceCareRequest(request, 'https://api.example.test'), payload);
  } finally { globalThis.fetch = originalFetch; }
});

test('valid verified analysis still reaches the screen', async () => {
  const originalFetch = globalThis.fetch;
  try {
    const payload = {
      status: 'verified', product: request,
      officialSources: { manualUrl: 'https://www.dyson.co.jp/support/SV20' },
      analysis: {
        manufacturer: 'Dyson', model: 'SV20', analyzedAt: '2026-10-25T00:00:00.000Z', requiresUserReview: true,
        tasks: [{ name: 'フィルター清掃', recommendedIntervalDays: 30, steps: ['ほこりを取る'], tools: [], safetyCautions: [],
          evidence: [{ url: 'https://www.dyson.co.jp/support/SV20' }] }],
      },
    };
    globalThis.fetch = async () => Response.json(payload);
    assert.deepEqual(await analyzeApplianceCareRequest(request, 'https://api.example.test'), payload);
  } finally { globalThis.fetch = originalFetch; }
});

test('stored analysis compatibility never weakens the review and source requirements for newly received API results', async () => {
  const originalFetch = globalThis.fetch;
  const source = 'https://www.dyson.co.jp/support/SV20';
  const task = { name: 'フィルター清掃', steps: ['冷水で洗う'], tools: [], safetyCautions: [], evidence: [{ url: source }], estimatedMinutes: 0 };
  const analysis = { manufacturer: 'Dyson', model: 'SV20', analyzedAt: '2026-10-28T00:00:00Z', requiresUserReview: true, tasks: [task] };
  const response = value => ({ status: 'verified', product: request, officialSources: { manualUrl: source }, analysis: value });
  try {
    for (const value of [
      { analyzedAt: analysis.analyzedAt, tasks: [] }, { ...analysis, tasks: [] }, { ...analysis, requiresUserReview: false },
      { ...analysis, analyzedAt: 'invalid' },
      ...[{ steps: [] }, { evidence: [] }, { evidence: [{ url: 'https://example.test/manual' }] }, { recommendedConditions: [''] },
        { recommendedConditions: '乾燥後' }, { recommendedIntervalDays: 0 }, { estimatedMinutes: -1 }].map(patch => ({ ...analysis, tasks: [{ ...task, ...patch }] })),
    ]) {
      globalThis.fetch = async () => Response.json(response(value));
      assert.equal((await analyzeApplianceCareRequest(request, 'https://api.example.test')).status, 'error');
    }
    globalThis.fetch = async () => Response.json(response(analysis));
    assert.deepEqual(await analyzeApplianceCareRequest(request, 'https://api.example.test'), response(analysis));
  } finally { globalThis.fetch = originalFetch; }
});

test('cancelled appliance requests make no network call and abort an in-flight request', async () => {
  const originalFetch = globalThis.fetch;
  try {
    let calls = 0; let requestSignal;
    globalThis.fetch = async (_url, options) => {
      calls++; requestSignal = options.signal;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    };
    const cancelled = new AbortController(); cancelled.abort();
    assert.match((await analyzeApplianceCareRequest(request, 'https://api.example.test', 1000, undefined, cancelled.signal)).message, /中断/);
    assert.equal(calls, 0);
    const controller = new AbortController();
    const pending = analyzeApplianceCareRequest(request, 'https://api.example.test', 1000, undefined, controller.signal);
    controller.abort();
    assert.match((await pending).message, /中断/);
    assert.equal(calls, 1); assert.equal(requestSignal.aborted, true);
  } finally { globalThis.fetch = originalFetch; }
});

test('appliance polling stops immediately after cancellation instead of requesting later job updates', async () => {
  const originalFetch = globalThis.fetch;
  try {
    let calls = 0; const controller = new AbortController();
    globalThis.fetch = async () => {
      calls++;
      return Response.json(calls === 1 ? { jobId: 'job' } : { stage: 'product_verification', done: false, pollAfterMs: 30000 });
    };
    const result = await analyzeApplianceCareRequest(request, 'https://api.example.test', 1000, () => controller.abort(), controller.signal);
    assert.match(result.message, /中断/); assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('appliance client rejects delayed results after cancellation even if fetch ignores abort', async () => {
  const originalFetch = globalThis.fetch;
  try {
    let resolve; const controller = new AbortController();
    globalThis.fetch = () => new Promise((done) => { resolve = done; });
    const pending = analyzeApplianceCareRequest(request, 'https://api.example.test', 1000, undefined, controller.signal);
    controller.abort();
    resolve(Response.json({ status: 'error', code: 'UNEXPECTED_LATE_RESULT', message: 'stale' }));
    const result = await pending;
    assert.match(result.message, /中断/); assert.notEqual(result.code, 'UNEXPECTED_LATE_RESULT');
  } finally { globalThis.fetch = originalFetch; }
});
