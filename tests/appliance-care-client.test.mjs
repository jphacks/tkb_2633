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
