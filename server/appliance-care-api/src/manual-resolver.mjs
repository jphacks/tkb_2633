import {
  isAllowedOfficialUrl,
  isBackedByOfficialSearchResult,
} from './official-domains.mjs';

const MAX_MANUAL_BYTES = 50 * 1024 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;

const MANUAL_RESOLUTION_SCHEMA = {
  type: 'object',
  properties: {
    manualUrl: { type: ['string', 'null'] },
    format: { type: 'string', enum: ['pdf', 'web_manual', 'support_page', 'none'] },
    title: { type: ['string', 'null'] },
  },
  required: ['manualUrl', 'format', 'title'],
  additionalProperties: false,
};

const MANUAL_RESOLVER_INSTRUCTIONS = [
  'メーカー公式サイトだけをweb_searchし、この製品の公式取扱説明書を1つ特定してください。',
  '優先順はメーカー公式PDF、公式Webマニュアル、公式サポートページです。',
  '指定ドメイン以外は使わず、通販や第三者サイトを根拠にしないでください。',
  '存在しないURLを作らず、見つからない場合はmanualUrlをnull、formatをnoneにしてください。',
  '指定されたメーカー、製品名、型番に対応する資料だけを選んでください。',
].join('\n');

export class ManualNotFoundError extends Error {
  constructor() {
    super('No official manual was found');
    this.name = 'ManualNotFoundError';
  }
}

export class ManualFetchError extends Error {
  constructor() {
    super('Official manual could not be fetched safely');
    this.name = 'ManualFetchError';
  }
}

export async function resolveOfficialManual(product, { ai, fetchImpl = fetch }) {
  const search = await ai.createStructured({
    name: 'official_manual_resolution',
    schema: MANUAL_RESOLUTION_SCHEMA,
    tools: [{ type: 'web_search', filters: { allowed_domains: product.allowedDomains } }],
    requireTool: true,
    input: [
      { role: 'developer', content: [{ type: 'input_text', text: MANUAL_RESOLVER_INSTRUCTIONS }] },
      {
        role: 'user',
        content: [{
          type: 'input_text',
          text: JSON.stringify({
            manufacturer: product.manufacturer,
            productName: product.productName,
            modelNumber: product.modelNumber,
            verifiedProductUrl: product.officialProductUrl,
            allowedDomains: product.allowedDomains,
          }),
        }],
      },
    ],
  });

  const candidates = [];
  if (search.value?.format !== 'none'
    && typeof search.value?.manualUrl === 'string'
    && isBackedByOfficialSearchResult(search.value.manualUrl, search.sourceUrls, product.allowedDomains)) {
    candidates.push({ url: search.value.manualUrl, format: search.value.format });
  }
  if (product.officialManualUrl
    && isBackedByOfficialSearchResult(product.officialManualUrl, product.sourceUrls, product.allowedDomains)) {
    candidates.push({
      url: product.officialManualUrl,
      format: product.officialManualUrl.toLocaleLowerCase('en-US').split('?')[0].endsWith('.pdf') ? 'pdf' : 'web_manual',
    });
  }

  if (candidates.length === 0) throw new ManualNotFoundError();

  let fetchFailed = false;
  const inspectedCandidates = [];
  for (const candidate of uniqueCandidates(candidates).sort((left, right) => manualFormatRank(left) - manualFormatRank(right))) {
    try {
      const inspected = await inspectOfficialManual(candidate.url, product.allowedDomains, fetchImpl);
      inspectedCandidates.push(inspected);
    } catch {
      fetchFailed = true;
    }
  }
  if (inspectedCandidates.length === 0) {
    if (fetchFailed) throw new ManualFetchError();
    throw new ManualNotFoundError();
  }
  return {
    ...inspectedCandidates[0],
    title: typeof search.value?.title === 'string' ? search.value.title.slice(0, 200) : undefined,
    fallbackCandidates: inspectedCandidates.slice(1),
  };
}

function manualFormatRank(candidate) {
  const pathname = new URL(candidate.url).pathname.toLocaleLowerCase('en-US');
  if (candidate.format === 'pdf' || pathname.endsWith('.pdf')) return 0;
  if (candidate.format === 'web_manual') return 1;
  return 2;
}

export async function inspectOfficialManual(url, allowedDomains, fetchImpl = fetch) {
  const final = await requestOfficialUrl(url, allowedDomains, fetchImpl, 'HEAD');
  const contentType = final.response.headers.get('content-type')?.toLocaleLowerCase('en-US') ?? '';
  const contentLength = Number(final.response.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_MANUAL_BYTES) throw new ManualFetchError();

  let kind;
  if (contentType.includes('application/pdf') || new URL(final.url).pathname.toLocaleLowerCase('en-US').endsWith('.pdf')) {
    kind = 'pdf';
  } else if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
    kind = 'web_manual';
  } else {
    throw new ManualFetchError();
  }
  final.response.body?.cancel().catch(() => undefined);
  return { url: final.url, kind };
}

export async function fetchOfficialManualText(manual, allowedDomains, fetchImpl = fetch) {
  if (manual.kind === 'pdf') throw new ManualFetchError();
  const final = await requestOfficialUrl(manual.url, allowedDomains, fetchImpl, 'GET');
  const contentLength = Number(final.response.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_HTML_BYTES) throw new ManualFetchError();
  const bytes = Buffer.from(await final.response.arrayBuffer());
  if (bytes.byteLength > MAX_HTML_BYTES) throw new ManualFetchError();
  const contentType = final.response.headers.get('content-type')?.toLocaleLowerCase('en-US') ?? '';
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) throw new ManualFetchError();
  return { url: final.url, text: stripHtml(bytes.toString('utf8')) };
}

async function requestOfficialUrl(initialUrl, allowedDomains, fetchImpl, initialMethod) {
  let current = initialUrl;
  let method = initialMethod;

  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    if (!isAllowedOfficialUrl(current, allowedDomains)) throw new ManualFetchError();
    let response;
    try {
      response = await fetchImpl(current, {
        method,
        redirect: 'manual',
        headers: { accept: 'application/pdf, text/html;q=0.9, */*;q=0.1' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ManualFetchError();
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      response.body?.cancel().catch(() => undefined);
      if (!location || redirectCount === 5) throw new ManualFetchError();
      let nextUrl;
      try {
        nextUrl = new URL(location, current).toString();
      } catch {
        throw new ManualFetchError();
      }
      if (!isAllowedOfficialUrl(nextUrl, allowedDomains)) throw new ManualFetchError();
      current = nextUrl;
      continue;
    }

    if ((response.status === 405 || response.status === 501) && method === 'HEAD') {
      response.body?.cancel().catch(() => undefined);
      method = 'GET';
      continue;
    }
    if (!response.ok) {
      response.body?.cancel().catch(() => undefined);
      throw new ManualFetchError();
    }
    return { url: current, response };
  }
  throw new ManualFetchError();
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.url)) return false;
    seen.add(candidate.url);
    return true;
  });
}

function stripHtml(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
