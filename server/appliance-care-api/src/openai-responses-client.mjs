const RESPONSES_URL = 'https://api.openai.com/v1/responses';

export class OpenAIResponsesClient {
  constructor({ apiKey = process.env.OPENAI_API_KEY, model = process.env.OPENAI_MODEL ?? 'gpt-5.5', fetchImpl = fetch } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.fetchImpl = fetchImpl;
  }

  get isConfigured() {
    return typeof this.apiKey === 'string' && this.apiKey.trim().length > 0;
  }

  async createStructured({ name, schema, input, tools, requireTool = false }) {
    if (!this.isConfigured) throw new Error('OpenAI API is not configured');

    const body = {
      model: this.model,
      input,
      store: false,
      text: { format: { type: 'json_schema', name, strict: true, schema } },
    };
    if (tools?.length) {
      body.tools = tools;
      body.include = ['web_search_call.action.sources'];
      if (requireTool) body.tool_choice = 'required';
    }

    let response;
    try {
      response = await this.fetchImpl(RESPONSES_URL, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + this.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw temporaryNetworkError();
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 408 || response.status === 429 || response.status >= 500) throw temporaryNetworkError();
      throw new Error('OpenAI request failed');
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error('OpenAI response was not valid JSON');
    }

    const outputText = getOutputText(payload);
    if (!outputText) throw new Error('OpenAI returned no structured output');

    let value;
    try {
      value = JSON.parse(outputText);
    } catch {
      throw new Error('OpenAI structured output was not valid JSON');
    }

    return { value, sourceUrls: getWebSearchSources(payload) };
  }
}

function temporaryNetworkError() {
  const error = new Error('Temporary AI service failure');
  error.code = 'TEMPORARY_NETWORK_ERROR';
  return error;
}

function getOutputText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.length > 0) return payload.output_text;
  for (const item of payload?.output ?? []) {
    if (item?.type !== 'message') continue;
    for (const content of item.content ?? []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') return content.text;
    }
  }
  return undefined;
}

function getWebSearchSources(payload) {
  const sources = [];
  for (const item of payload?.output ?? []) {
    if (item?.type !== 'web_search_call') continue;
    for (const source of item.action?.sources ?? []) {
      if (typeof source?.url === 'string') sources.push(source.url);
    }
  }
  return [...new Set(sources)];
}
