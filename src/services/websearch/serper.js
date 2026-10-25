/**
 * Serper-compatible REST search provider.
 *
 * This is the pre-existing `web_search` backend, moved behind the provider
 * interface so it can take part in the same fallback chain as the MCP servers.
 * It keeps its own 20-entry session cache and never retries in a loop.
 */

import { CancelledError, SearchError, ValidationError } from '../../utils/errors.js';

export const SERPER_DEFAULT_ENDPOINT = 'https://google.serper.dev/search';
const MAX_QUERY_CHARS = 400;
const MAX_CACHE_ENTRIES = 20;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TITLE = 200;
const MAX_SNIPPET = 320;
const MAX_URL = 500;
const MAX_RESULTS = 10;

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function pickArray(data, names) {
  for (const name of names) {
    const value = data?.[name];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function pickObject(data, names) {
  for (const name of names) {
    const value = data?.[name];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  }
  return null;
}

function normalizeResult(item, rank) {
  if (!item || typeof item !== 'object') return null;
  const url = clean(item.link || item.url || item.href, MAX_URL);
  if (!url) return null;
  const title = clean(item.title || item.name || item.heading, MAX_TITLE);
  const snippet = clean(
    item.snippet ||
      item.description ||
      item.summary ||
      (Array.isArray(item.snippet_highlighted_words) ? item.snippet_highlighted_words.join(' ') : ''),
    MAX_SNIPPET,
  );
  const source = clean(item.source || item.displayed_link || item.displayLink, 120) || null;
  const date = clean(item.date || item.publishedDate || item.published_at, 40) || null;
  return {
    rank,
    title: title || url,
    url,
    snippet: snippet || null,
    ...(source ? { source } : {}),
    ...(date ? { date } : {}),
  };
}

function normalizeAnswerBox(data) {
  const box = pickObject(data, ['answerBox', 'answer_box', 'answer']);
  if (!box) return null;
  const text = clean(box.answer || box.snippet || box.description || box.text, MAX_SNIPPET);
  if (!text) return null;
  const title = clean(box.title || box.heading, MAX_TITLE) || null;
  const url = clean(box.link || box.url, MAX_URL) || null;
  return { ...(title ? { title } : {}), text, ...(url ? { url } : {}) };
}

function normalizePeopleAlsoAsk(data) {
  return pickArray(data, ['peopleAlsoAsk', 'people_also_ask', 'related_questions'])
    .map((item) => ({
      question: clean(item?.question || item?.title, MAX_TITLE),
      snippet: clean(item?.snippet || item?.answer || item?.description, MAX_SNIPPET) || null,
    }))
    .filter((item) => item.question)
    .slice(0, 4);
}

function normalizeRelated(data) {
  return pickArray(data, ['relatedSearches', 'related_searches'])
    .map((item) => clean(typeof item === 'string' ? item : item?.query, 160))
    .filter(Boolean)
    .slice(0, 5);
}

function httpError(status, query) {
  const suffix = `(query: ${JSON.stringify(query.slice(0, 80))})`;
  if (status === 401 || status === 403) {
    return new SearchError(
      `Web search rejected the API key (HTTP ${status}). Check SEARCH_API_KEY and that the endpoint belongs to the same provider. ${suffix}`,
      { code: 'SEARCH_AUTH', status },
    );
  }
  if (status === 402 || status === 429) {
    return new SearchError(
      `Web search is out of quota or rate limited (HTTP ${status}). Wait before searching again; do not retry in a loop. ${suffix}`,
      { code: 'SEARCH_RATE_LIMIT', status, retryable: true },
    );
  }
  if (status >= 500) {
    return new SearchError(`Web search provider failed (HTTP ${status}). ${suffix}`, {
      code: 'SEARCH_UPSTREAM',
      status,
      retryable: true,
    });
  }
  return new SearchError(`Web search failed (HTTP ${status}). ${suffix}`, { code: 'SEARCH_FAILED', status });
}

/**
 * Build the Serper provider.
 *
 * @param {object} options
 * @param {object} options.config validated config
 * @param {object} [options.logger]
 * @param {Function} [options.fetch] injectable fetch (tests)
 */
export function createSerperProvider({ config, logger = null, fetch: fetchImpl = null } = {}) {
  const apiKey = String(config?.webSearchApiKey || '').trim();
  const endpoint = String(config?.webSearchEndpoint || SERPER_DEFAULT_ENDPOINT);
  const authHeader = String(config?.webSearchAuthHeader || 'X-API-KEY');
  const baseResults = Math.max(1, Math.min(Number(config?.webSearchResults) || 5, MAX_RESULTS));
  const timeoutMs = Math.max(1000, Number(config?.webSearchTimeoutMs) || 15000);
  const request = fetchImpl || ((...args) => globalThis.fetch(...args));
  const cache = new Map();
  const host = (() => {
    try {
      return new URL(endpoint).host;
    } catch {
      return endpoint;
    }
  })();

  async function search({ query, depth = 'standard' } = {}, { signal = null } = {}) {
    const text = clean(query, MAX_QUERY_CHARS);
    if (!text) throw new ValidationError('query must be a non-empty string.');
    const mode = depth === 'deep' ? 'deep' : 'standard';
    const num = mode === 'deep' ? Math.min(baseResults * 2, MAX_RESULTS) : baseResults;
    const key = `${mode}\u0000${text.toLowerCase()}`;

    const cached = cache.get(key);
    if (cached) {
      logger?.debug('web search cache hit', { provider: 'serper', query: text.slice(0, 80) });
      return { ...cached, cached: true, elapsed_ms: 0 };
    }

    if (signal?.aborted) throw new CancelledError('Task cancelled by user.');

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    const startedAt = Date.now();
    let response;
    let raw;
    try {
      response = await request(endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          [authHeader]: authHeader.toLowerCase() === 'authorization' ? `Bearer ${apiKey}` : apiKey,
        },
        body: JSON.stringify({ q: text, num, gl: 'us', hl: 'en' }),
        signal: controller.signal,
      });
      raw = await response.text();
    } catch (error) {
      if (signal?.aborted) throw new CancelledError('Task cancelled by user.');
      if (timedOut || error?.name === 'AbortError') {
        throw new SearchError(`Web search timed out after ${timeoutMs}ms.`, {
          code: 'SEARCH_TIMEOUT',
          retryable: true,
        });
      }
      const reason = error?.cause?.message || error?.message || String(error);
      throw new SearchError(`Cannot reach the web search endpoint ${host}: ${reason}`, {
        code: 'SEARCH_NETWORK',
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    if (!response.ok) throw httpError(response.status, text);
    if (typeof raw !== 'string' || raw.length > MAX_RESPONSE_BYTES) {
      throw new SearchError('Web search returned an oversized or empty response.', { code: 'SEARCH_BAD_RESPONSE' });
    }

    let data;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      throw new SearchError('Web search returned a response that is not JSON. Check WEB_SEARCH_ENDPOINT.', {
        code: 'SEARCH_BAD_RESPONSE',
      });
    }
    if (!data || typeof data !== 'object') {
      throw new SearchError('Web search returned an empty JSON body.', { code: 'SEARCH_BAD_RESPONSE' });
    }

    const results = pickArray(data, ['organic', 'organic_results', 'results'])
      .map((item, index) => normalizeResult(item, index + 1))
      .filter(Boolean)
      .slice(0, num);

    const output = {
      query: text,
      depth: mode,
      provider: 'serper',
      endpoint: host,
      result_count: results.length,
      results,
      answer_box: normalizeAnswerBox(data),
      people_also_ask: normalizePeopleAlsoAsk(data),
      related_searches: normalizeRelated(data),
      ...(typeof data.credits === 'number' ? { credits: data.credits } : {}),
      cached: false,
      elapsed_ms: Date.now() - startedAt,
      fetched_at: new Date().toISOString(),
    };

    cache.set(key, output);
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    logger?.debug('web search complete', {
      provider: 'serper',
      query: text.slice(0, 80),
      results: results.length,
      ms: output.elapsed_ms,
    });
    return output;
  }

  return {
    id: 'serper',
    label: 'Serper',
    kind: 'rest',
    transport: 'https',
    requiresKey: true,
    configured: Boolean(apiKey),
    enabled: true,
    capabilities: { search: true, extract: false },
    endpoint: host,
    async search(input, ctx) {
      return search(input, ctx);
    },
    async extract() {
      return null;
    },
    async close() {},
  };
}

export const SERPER_LIMITS = { MAX_QUERY_CHARS, MAX_RESULTS, MAX_CACHE_ENTRIES };
