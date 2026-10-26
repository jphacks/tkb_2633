import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import { isAllowedOfficialUrl, officialDomainsForManufacturer } from '../server/appliance-care-api/src/official-domains.mjs';
import { resolveProduct } from '../server/appliance-care-api/src/product-resolver.mjs';
import { ManualFetchError, ManualNotFoundError, inspectOfficialManual, resolveOfficialManual } from '../server/appliance-care-api/src/manual-resolver.mjs';
import { analyzeOfficialManual, InvalidAiOutputError, validateAndDeduplicateTasks } from '../server/appliance-care-api/src/manual-analyzer.mjs';
import { analyzeApplianceCare, validateApplianceCareRequest } from '../server/appliance-care-api/src/service.mjs';
import { createApplianceCareHttpServer } from '../server/appliance-care-api/src/http-server.mjs';
import { OpenAIResponsesClient } from '../server/appliance-care-api/src/openai-responses-client.mjs';

const request = {
  manufacturer: 'Dyson',
  productName: 'V12 Detect Slim',
  modelNumber: 'SV20',
  category: 'vacuum_cleaner',
};
const productUrl = 'https://www.dyson.co.jp/support/vacuum-cleaners/cordless/v12-detect-slim';
const manualUrl = 'https://www.dyson.co.jp/content/manual/SV20.pdf';
const dysonDomains = ['dyson.co.jp'];

function validTask(overrides = {}) {
  return {
    name: 'フィルターのお手入れ',
    recommendedIntervalDays: null,
    recommendedConditions: ['汚れが気になったとき'],
    steps: ['フィルターを取り外して清掃する。'],
    tools: [],
    safetyCautions: ['完全に乾燥させてから取り付ける。'],
    estimatedMinutes: null,
    evidence: [{ url: manualUrl, pageOrSection: 'p. 12' }],
    ...overrides,
  };
}

function aiReturning(value, sourceUrls = []) {
  return { createStructured: async () => ({ value, sourceUrls }) };
}

test('official URL validation rejects lookalikes, credentials, ports, and non-HTTPS URLs', () => {
  assert.equal(isAllowedOfficialUrl('https://dyson.co.jp/manual.pdf', dysonDomains), true);
  assert.equal(isAllowedOfficialUrl('https://www.dyson.co.jp/manual.pdf', dysonDomains), true);
  assert.equal(isAllowedOfficialUrl('https://dyson.co.jp.attacker.example/manual.pdf', dysonDomains), false);
  assert.equal(isAllowedOfficialUrl('https://dyson.co.jp@attacker.example/manual.pdf', dysonDomains), false);
  assert.equal(isAllowedOfficialUrl('http://dyson.co.jp/manual.pdf', dysonDomains), false);
  assert.equal(isAllowedOfficialUrl('https://dyson.co.jp:8443/manual.pdf', dysonDomains), false);
  assert.deepEqual(officialDomainsForManufacturer('ダイソン'), dysonDomains);
});

test('Product Resolver verifies exact manufacturer and model using official search sources', async () => {
  let invocation;
  const ai = {
    async createStructured(input) {
      invocation = input;
      return {
        value: {
          status: 'verified',
          manufacturer: 'Dyson',
          productName: 'V12 Detect Slim',
          modelNumber: 'SV20',
          officialProductUrl: productUrl,
          officialManualUrl: manualUrl,
          candidates: [],
        },
        sourceUrls: [productUrl, manualUrl],
      };
    },
  };

  const result = await resolveProduct(request, { ai });
  assert.equal(result.status, 'verified');
  assert.equal(result.modelNumber, 'SV20');
  assert.deepEqual(invocation.tools[0].filters.allowed_domains, dysonDomains);
  assert.equal(invocation.requireTool, true);
});

test('Product Resolver rejects invented model numbers and unofficial product URLs', async () => {
  const wrongModel = await resolveProduct(request, {
    ai: aiReturning({
      status: 'verified', manufacturer: 'Dyson', productName: 'V12 Detect Slim', modelNumber: 'SV99',
      officialProductUrl: productUrl, officialManualUrl: null, candidates: [],
    }, [productUrl]),
  });
  assert.deepEqual(wrongModel, { status: 'not_found' });

  const unofficial = await resolveProduct(request, {
    ai: aiReturning({
      status: 'verified', manufacturer: 'Dyson', productName: 'V12 Detect Slim', modelNumber: 'SV20',
      officialProductUrl: 'https://shop.example/product', officialManualUrl: null, candidates: [],
    }, ['https://shop.example/product']),
  });
  assert.deepEqual(unofficial, { status: 'not_found' });

  const differentManufacturer = await resolveProduct(request, {
    ai: aiReturning({
      status: 'verified', manufacturer: 'Dyson', productName: 'V12 Detect Slim', modelNumber: 'SV20',
      officialProductUrl: 'https://www.panasonic.jp/support/product', officialManualUrl: null, candidates: [],
    }, ['https://www.panasonic.jp/support/product']),
  });
  assert.deepEqual(differentManufacturer, { status: 'not_found' });

  const wrongProduct = await resolveProduct(request, {
    ai: aiReturning({
      status: 'verified', manufacturer: 'Dyson', productName: 'V11 Absolute', modelNumber: 'SV20',
      officialProductUrl: productUrl, officialManualUrl: null, candidates: [],
    }, [productUrl]),
  });
  assert.deepEqual(wrongProduct, { status: 'not_found' });
});

test('Product Resolver returns ambiguous only with two official candidates', async () => {
  const candidates = [
    { manufacturer: 'Dyson', productName: 'V12 Detect Slim', modelNumber: 'SV20', officialProductUrl: productUrl },
    { manufacturer: 'Dyson', productName: 'V12 Slim', modelNumber: 'SV30', officialProductUrl: 'https://www.dyson.co.jp/support/vacuum-cleaners/v12-slim' },
  ];
  const ai = aiReturning({
    status: 'ambiguous', manufacturer: null, productName: null, modelNumber: null,
    officialProductUrl: null, officialManualUrl: null, candidates,
  }, candidates.map((item) => item.officialProductUrl));
  const result = await resolveProduct(request, { ai });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.candidates.length, 2);
});

test('Manual Resolver prefers an official PDF and validates the final response type', async () => {
  let fetchUrl;
  let fetchMethod;
  const fetchImpl = async (url, options) => {
    fetchUrl = url;
    fetchMethod = options.method;
    return new Response(null, { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': '128' } });
  };
  const resolved = await resolveOfficialManual({
    ...request, officialProductUrl: productUrl, officialManualUrl: undefined,
    allowedDomains: dysonDomains, sourceUrls: [productUrl],
  }, {
    ai: aiReturning({ manualUrl, format: 'pdf', title: 'V12 Detect Slim Manual' }, [manualUrl]),
    fetchImpl,
  });
  assert.equal(resolved.kind, 'pdf');
  assert.equal(fetchUrl, manualUrl);
  assert.equal(fetchMethod, 'HEAD');
});

test('Manual Resolver refuses a redirect to an unofficial host', async () => {
  await assert.rejects(
    inspectOfficialManual(manualUrl, dysonDomains, async () => new Response(null, {
      status: 302,
      headers: { location: 'https://attacker.example/manual.pdf' },
    })),
    ManualFetchError,
  );
});

test('Manual Resolver checks an official PDF before a web manual even if search ranks the web page first', async () => {
  const webManualUrl = 'https://www.dyson.co.jp/support/vacuum-cleaners/cordless/v12-detect-slim';
  const order = [];
  const product = {
    ...request,
    officialProductUrl: productUrl,
    officialManualUrl: manualUrl,
    allowedDomains: dysonDomains,
    sourceUrls: [productUrl, manualUrl],
  };
  const resolved = await resolveOfficialManual(product, {
    ai: aiReturning({ manualUrl: webManualUrl, format: 'web_manual', title: 'Support' }, [webManualUrl]),
    fetchImpl: async (url) => {
      order.push(url);
      return new Response(null, { status: 200, headers: {
        'content-type': url.endsWith('.pdf') ? 'application/pdf' : 'text/html',
      } });
    },
  });
  assert.equal(resolved.kind, 'pdf');
  assert.equal(order[0], manualUrl);
  assert.equal(resolved.fallbackCandidates[0].url, webManualUrl);
});

test('Manual Analyzer converts explicit monthly intervals to 30 days and preserves evidence', async () => {
  const monthly = validTask({
    name: 'ダストケース清掃',
    recommendedIntervalDays: 30,
    recommendedConditions: [],
    evidence: [{ url: manualUrl, pageOrSection: 'お手入れ p. 16' }],
  });
  let requestBody;
  const analysis = await analyzeOfficialManual({
    ...request, allowedDomains: dysonDomains,
  }, { url: manualUrl, kind: 'pdf' }, {
    now: () => new Date('2026-10-24T00:00:00.000Z'),
    ai: { async createStructured(input) { requestBody = input; return { value: { tasks: [monthly] } }; } },
  });
  assert.equal(analysis.requiresUserReview, true);
  assert.equal(analysis.tasks[0].recommendedIntervalDays, 30);
  assert.equal(analysis.tasks[0].evidence[0].url, manualUrl);
  assert.equal(requestBody.input[1].content[1].type, 'input_file');
  assert.equal(requestBody.input[1].content[1].file_url, manualUrl);
  assert.equal(requestBody.input[1].content[1].detail, 'high');
  assert.equal('filename' in requestBody.input[1].content[1], false);
});

test('condition-only maintenance keeps no interval and duplicate tasks are merged', () => {
  const result = validateAndDeduplicateTasks([
    validTask(),
    validTask({
      name: 'フィルターのお手入れ',
      recommendedConditions: ['吸引力が低下したとき'],
      steps: ['十分に乾燥させる。'],
      safetyCautions: [],
      evidence: [{ url: manualUrl, pageOrSection: 'p. 13' }],
    }),
  ], manualUrl, dysonDomains);
  assert.equal(result.length, 1);
  assert.equal(result[0].recommendedIntervalDays, undefined);
  assert.deepEqual(result[0].recommendedConditions, ['汚れが気になったとき', '吸引力が低下したとき']);
  assert.equal(result[0].steps.length, 2);
  assert.equal(result[0].evidence.length, 2);
});

test('Manual Analyzer rejects unofficial evidence, empty tasks, and conflicting duplicate intervals', () => {
  assert.throws(() => validateAndDeduplicateTasks([validTask({
    evidence: [{ url: 'https://example.org/manual.pdf' }],
  })], manualUrl, dysonDomains), InvalidAiOutputError);
  assert.throws(() => validateAndDeduplicateTasks([], manualUrl, dysonDomains), InvalidAiOutputError);
  assert.throws(() => validateAndDeduplicateTasks([
    validTask({ recommendedIntervalDays: 7 }),
    validTask({ recommendedIntervalDays: 30 }),
  ], manualUrl, dysonDomains), InvalidAiOutputError);
});

test('not_found stops before manual resolution and AI analysis', async () => {
  let downstreamCalls = 0;
  const result = await analyzeApplianceCare(request, {
    resolveProduct: async () => ({ status: 'not_found' }),
    resolveManual: async () => { downstreamCalls += 1; throw new Error('should not run'); },
    analyzeManual: async () => { downstreamCalls += 1; throw new Error('should not run'); },
  });
  assert.equal(result.status, 'not_found');
  assert.equal(result.code, 'PRODUCT_NOT_FOUND');
  assert.equal(downstreamCalls, 0);
});

test('service distinguishes missing manuals, analysis failures, and transient connection failures', async () => {
  const verified = async () => ({
    status: 'verified', manufacturer: 'Dyson', productName: 'V12 Detect Slim', modelNumber: 'SV20',
  });
  const base = { resolveProduct: verified, resolveManual: async () => ({ url: manualUrl, kind: 'pdf' }) };
  const missingManual = await analyzeApplianceCare(request, {
    ...base, async resolveManual() { throw new ManualNotFoundError(); }, async analyzeManual() { throw new Error('not called'); },
  });
  assert.equal(missingManual.code, 'MANUAL_NOT_FOUND');

  const failedAnalysis = await analyzeApplianceCare(request, {
    ...base, async analyzeManual() { throw new Error('private upstream details'); },
  });
  assert.equal(failedAnalysis.code, 'ANALYSIS_FAILED');
  assert.equal(failedAnalysis.message.includes('private upstream'), false);

  const transientError = new Error('private network details');
  transientError.code = 'TEMPORARY_NETWORK_ERROR';
  const transient = await analyzeApplianceCare(request, {
    ...base, async analyzeManual() { throw transientError; },
  });
  assert.equal(transient.code, 'TEMPORARY_NETWORK_ERROR');
});

test('service falls back to an inspected official web manual when PDF analysis fails', async () => {
  const webManual = { url: 'https://www.dyson.co.jp/support/vacuum-cleaners/cordless/v12-detect-slim', kind: 'web_manual' };
  const calls = [];
  const analysis = {
    manufacturer: 'Dyson', model: 'SV20', tasks: [validTask()],
    analyzedAt: '2026-10-24T00:00:00.000Z', requiresUserReview: true,
  };
  const result = await analyzeApplianceCare(request, {
    resolveProduct: async () => ({
      status: 'verified', manufacturer: 'Dyson', productName: 'V12 Detect Slim', modelNumber: 'SV20',
    }),
    resolveManual: async () => ({ url: manualUrl, kind: 'pdf', fallbackCandidates: [webManual] }),
    analyzeManual: async (_product, manual) => {
      calls.push(manual.url);
      if (manual.kind === 'pdf') throw new Error('PDF input unsupported in fixture');
      return analysis;
    },
  });
  assert.equal(result.status, 'verified');
  assert.deepEqual(calls, [manualUrl, webManual.url]);
  assert.equal(result.officialSources.manualUrl, webManual.url);
});

test('request validation rejects empty, oversized, and control-character fields', () => {
  assert.equal(validateApplianceCareRequest(request), true);
  assert.equal(validateApplianceCareRequest({ ...request, modelNumber: ' '.repeat(3) }), false);
  assert.equal(validateApplianceCareRequest({ ...request, modelNumber: 'SV\n20' }), false);
  assert.equal(validateApplianceCareRequest({ ...request, productName: 'x'.repeat(121) }), false);
});

test('Responses API client uses strict JSON Schema, required web search, and does not store responses', async () => {
  let endpoint;
  let sentBody;
  const client = new OpenAIResponsesClient({
    apiKey: 'test-only-key',
    model: 'gpt-5.5',
    fetchImpl: async (url, options) => {
      endpoint = url;
      sentBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        output: [
          { type: 'message', content: [{ type: 'output_text', text: '{"status":"not_found"}' }] },
          { type: 'web_search_call', action: { sources: [{ url: productUrl }] } },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  const response = await client.createStructured({
    name: 'test_schema',
    schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'], additionalProperties: false },
    input: [],
    tools: [{ type: 'web_search', filters: { allowed_domains: dysonDomains } }],
    requireTool: true,
  });
  assert.equal(endpoint, 'https://api.openai.com/v1/responses');
  assert.equal(sentBody.store, false);
  assert.equal(sentBody.text.format.type, 'json_schema');
  assert.equal(sentBody.text.format.strict, true);
  assert.equal(sentBody.tool_choice, 'required');
  assert.deepEqual(sentBody.include, ['web_search_call.action.sources']);
  assert.deepEqual(response.value, { status: 'not_found' });
  assert.deepEqual(response.sourceUrls, [productUrl]);
});

test('HTTP API returns 400 for invalid request and hides internal error details', async () => {
  const dependencies = {
    async resolveProduct() {
      return { status: 'verified', manufacturer: 'Dyson', productName: 'V12 Detect Slim', modelNumber: 'SV20', allowedDomains: dysonDomains };
    },
    async resolveManual() { return { url: manualUrl, kind: 'pdf' }; },
    async analyzeManual() { throw new Error('sensitive internal exception and key-like value'); },
  };
  const server = createApplianceCareHttpServer({ dependencies });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const invalid = await fetch(baseUrl + '/api/appliance-care/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, modelNumber: '' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, 'INVALID_REQUEST');

    const failed = await fetch(baseUrl + '/api/appliance-care/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    });
    assert.equal(failed.status, 502);
    const payload = await failed.json();
    assert.equal(payload.code, 'ANALYSIS_FAILED');
    assert.equal(JSON.stringify(payload).includes('sensitive internal'), false);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('HTTP API validates requests before reporting a missing OpenAI configuration', async () => {
  const server = createApplianceCareHttpServer({ aiConfigured: false, dependencies: {} });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const endpoint = `http://127.0.0.1:${port}/api/appliance-care/analyze`;
  try {
    const invalid = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, modelNumber: '' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, 'INVALID_REQUEST');

    const valid = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    });
    assert.equal(valid.status, 503);
    const payload = await valid.json();
    assert.equal(payload.code, 'ANALYSIS_FAILED');
    assert.equal(JSON.stringify(payload).includes('OPENAI_API_KEY'), false);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('HTTP API returns not_found, ambiguous candidates, and verified analysis shapes', async () => {
  const dependencies = {
    async resolveProduct(input) {
      if (input.productName === '架空製品') return { status: 'not_found' };
      if (input.productName === '曖昧な製品') {
        return {
          status: 'ambiguous',
          candidates: [
            { manufacturer: 'Dyson', productName: 'V12 Detect Slim', modelNumber: 'SV20', officialProductUrl: productUrl },
            { manufacturer: 'Dyson', productName: 'V12 Slim', modelNumber: 'SV30', officialProductUrl: productUrl + '/other' },
          ],
        };
      }
      return {
        status: 'verified',
        manufacturer: 'Dyson',
        productName: 'V12 Detect Slim',
        modelNumber: 'SV20',
        officialProductUrl: productUrl,
        allowedDomains: dysonDomains,
      };
    },
    async resolveManual() { return { url: manualUrl, kind: 'pdf' }; },
    async analyzeManual() {
      return {
        manufacturer: 'Dyson',
        model: 'SV20',
        tasks: [validTask()],
        analyzedAt: '2026-10-24T00:00:00.000Z',
        requiresUserReview: true,
      };
    },
  };
  const server = createApplianceCareHttpServer({ dependencies });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const endpoint = `http://127.0.0.1:${port}/api/appliance-care/analyze`;
  const post = async (body) => fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    const notFoundResponse = await post({ ...request, productName: '架空製品' });
    assert.equal(notFoundResponse.status, 200);
    assert.equal((await notFoundResponse.json()).status, 'not_found');

    const ambiguousResponse = await post({ ...request, productName: '曖昧な製品' });
    const ambiguous = await ambiguousResponse.json();
    assert.equal(ambiguousResponse.status, 200);
    assert.equal(ambiguous.status, 'ambiguous');
    assert.equal(ambiguous.candidates.length, 2);

    const verifiedResponse = await post(request);
    const verified = await verifiedResponse.json();
    assert.equal(verifiedResponse.status, 200);
    assert.equal(verified.status, 'verified');
    assert.equal(verified.analysis.requiresUserReview, true);
    assert.equal(verified.analysis.tasks.length, 1);
    assert.equal(verified.officialSources.manualUrl, manualUrl);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('analysis jobs expose product and official-manual stages, and stop at product-not-found', async () => {
  let manualCalls = 0;
  let releaseProduct; let releaseAnalysis;
  const productGate = new Promise((resolve) => { releaseProduct = resolve; });
  const analysisGate = new Promise((resolve) => { releaseAnalysis = resolve; });
  const dependencies = {
    async resolveProduct(input) {
      if (input.productName === '架空製品') return { status: 'not_found' };
      // Observe the actual HTTP stage before advancing, independently of machine/CI load.
      await productGate;
      return {
        status: 'verified', manufacturer: 'Dyson', productName: 'V12 Detect Slim', modelNumber: 'SV20',
        officialProductUrl: productUrl, allowedDomains: dysonDomains,
      };
    },
    async resolveManual() {
      manualCalls += 1;
      return { url: manualUrl, kind: 'pdf' };
    },
    async analyzeManual() {
      await analysisGate;
      return {
        manufacturer: 'Dyson', model: 'SV20', tasks: [validTask()],
        analyzedAt: '2026-10-24T00:00:00.000Z', requiresUserReview: true,
      };
    },
  };
  const server = createApplianceCareHttpServer({ dependencies });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const waitForJob = async (jobId) => {
    const stages = new Set();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/appliance-care/jobs/${jobId}`);
      const status = await response.json();
      stages.add(status.stage);
      if (status.stage === 'product_verification') releaseProduct();
      if (status.stage === 'official_manual_analysis') releaseAnalysis();
      if (status.done) return { status, stages };
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('analysis job did not finish');
  };
  const startJob = async (body) => {
    const response = await fetch(`${baseUrl}/api/appliance-care/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 202);
    return (await response.json()).jobId;
  };

  try {
    const validJob = await waitForJob(await startJob(request));
    assert.equal(validJob.status.result.status, 'verified');
    assert.equal(validJob.stages.has('product_verification'), true);
    assert.equal(validJob.stages.has('official_manual_analysis'), true);
    assert.equal(manualCalls, 1);

    const unknownJob = await waitForJob(await startJob({ ...request, productName: '架空製品' }));
    assert.equal(unknownJob.status.result.status, 'not_found');
    assert.equal(unknownJob.status.result.code, 'PRODUCT_NOT_FOUND');
    assert.equal(manualCalls, 1);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
