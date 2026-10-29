/**
 * WebSearchManager — one search surface over several MCP providers.
 *
 * Responsibilities:
 *   - lazy connect + tool discovery per provider (no startup penalty);
 *   - map discovered tools to capabilities (search / extract) by name,
 *     description and input schema, never by a hard-coded tool name;
 *   - try providers in the configured order, with bounded retries and a
 *     temporary circuit breaker for repeated failures;
 *   - normalize every provider's payload to the same result shape;
 *   - report failures through typed errors and UI events without leaking keys.
 *
 * Fallback is deliberately not blind: an authentication/config error or a
 * provider without the requested capability is skipped immediately; empty but
 * valid results are recorded and the next provider may still be consulted.
 */

import { CancelledError, SearchError, ValidationError } from '../../utils/errors.js';
import { assertPublicUrl } from '../../utils/network.js';
import { buildProviders, describeProvider } from './providers.js';
import { callTool as defaultCallTool, closeConnection as defaultClose, connectProvider } from './mcp.js';
import { extractPayload, normalizeExtractPayload, normalizeSearchPayload } from './normalize.js';

const MAX_QUERY_CHARS = 400;
const BREAKER_THRESHOLD = 2;
const BREAKER_COOLDOWN_MS = 60_000;
const MAX_REASON = 90;

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Score every discovered tool and return the best fit for a capability. */
export function pickTool(tools, capability) {
  let best = null;
  let bestScore = 0;
  for (const tool of Array.isArray(tools) ? tools : []) {
    const name = String(tool?.name || '').toLowerCase();
    if (!name) continue;
    const description = String(tool?.description || '').toLowerCase();
    const props = tool?.inputSchema?.properties || {};
    const hasQuery = Boolean(props.query || props.q || props.search_query);
    const hasUrl = Boolean(props.url || props.urls || props.link);
    let score = 0;
    if (capability === 'search') {
      if (/search|serp/.test(name)) score += 10;
      else if (/search|serp/.test(description)) score += 4;
      if (hasQuery) score += 3;
      if (/scrape|extract|contents?|fetch|read|crawl/.test(name)) score -= 8;
    } else {
      if (/scrape|extract|contents?|fetch|markdown|read/.test(name)) score += 8;
      if (hasUrl) score += 4;
      if (/search|serp/.test(name)) score -= 8;
    }
    if (score > bestScore) {
      best = tool;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

/** Fill the tool's own schema instead of assuming one provider's argument names. */
export function buildToolArgs(tool, capability, input) {
  const props = tool?.inputSchema?.properties || {};
  const required = new Set(tool?.inputSchema?.required || []);
  const args = {};
  if (capability === 'search') {
    if (props.query) args.query = input.query;
    else if (props.q) args.q = input.query;
    else if (props.search_query) args.search_query = input.query;
    for (const key of ['limit', 'numResults', 'max_results', 'maxResults', 'count', 'num']) {
      if (props[key]) args[key] = input.maxResults;
    }
    if (props.depth) args.depth = input.depth;
    // Firecrawl's MCP schema requires a short statement of intent. It is
    // derived from the query, never invented as a search result.
    if (props.objective) {
      args.objective = String(input.objective || `Find current information about: ${input.query}`).slice(0, 1000);
    }
  } else {
    if (props.url) args.url = input.url;
    else if (props.urls) args.urls = [input.url];
    else if (props.link) args.link = input.url;
    if (props.formats) args.formats = ['markdown'];
    if (props.objective) {
      args.objective = String(input.objective || `Extract the readable content of ${input.url} for the agent.`).slice(0, 1000);
    }
  }
  for (const key of required) {
    if (args[key] === undefined) {
      throw new SearchError(`The provider tool ${tool?.name || 'unknown'} requires an unsupported argument "${key}".`, {
        code: 'MCP_ARGUMENTS',
      });
    }
  }
  return args;
}

function failureReason(error) {
  const code = error?.code || '';
  if (code === 'MCP_AUTH' || code === 'SEARCH_AUTH') return 'autentikasi gagal';
  if (code === 'MCP_RATE_LIMIT' || code === 'SEARCH_RATE_LIMIT') return 'rate limit';
  if (code === 'MCP_TIMEOUT' || code === 'SEARCH_TIMEOUT') return 'timeout';
  if (code === 'MCP_NETWORK' || code === 'SEARCH_NETWORK') return 'tidak dapat dihubungi';
  if (code === 'MCP_HANDSHAKE') return 'handshake MCP gagal';
  if (code === 'MCP_DISCOVERY') return 'tool discovery gagal';
  if (code === 'MCP_TOOL_MISSING') return 'tool tidak tersedia';
  if (code === 'MCP_ARGUMENTS') return 'skema argumen tidak cocok';
  if (code === 'MCP_BAD_RESPONSE') return 'respons tidak valid';
  if (code === 'MCP_PROVIDER_ERROR') return 'provider error';
  if (code === 'MCP_SPAWN') return 'gagal dijalankan';
  if (code === 'MCP_EMPTY_EXTRACT') return 'halaman kosong';
  if (error?.retryable) return clean(error.message, MAX_REASON);
  return clean(error?.message || 'gagal', MAX_REASON);
}

export class WebSearchManager {
  constructor({
    config = {},
    logger = null,
    onEvent = null,
    connect = connectProvider,
    callTool = defaultCallTool,
    closeConnection = defaultClose,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    providers = null,
    fetch = null,
  } = {}) {
    this.config = config;
    this.logger = logger;
    this.onEvent = onEvent;
    this.connect = connect;
    this.callToolImpl = callTool;
    this.closeConnection = closeConnection;
    this.sleep = sleep;
    this.now = now;
    this.enabled = config.webSearchEnabled !== false;
    this.fallbackEnabled = config.webSearchFallback !== false;
    this.timeoutMs = Math.max(1000, Number(config.webMcpTimeoutMs) || 8000);
    this.maxRetries = Math.max(0, Math.min(Number(config.webMcpMaxRetries) || 0, 5));
    this.maxResults = Math.max(1, Math.min(Number(config.webSearchResults) || 5, 10));
    this.providers = providers || buildProviders(config, { fetch });
    this.enabledOverrides = new Map();
    this.connections = new Map();
    this.pending = new Map();
    this.breakers = new Map();
    this.stats = new Map();
  }

  /** Providers in the configured order, including disabled/unconfigured ones. */
  list() {
    return this.providers.map((provider) => {
      const stat = this.stats.get(provider.id) || {};
      const breaker = this.breakers.get(provider.id);
      return {
        ...describeProvider(provider),
        enabled: this.isEnabled(provider),
        ...(provider.endpoint ? { endpoint: provider.endpoint } : {}),
        connected: this.connections.has(provider.id),
        lastStatus: stat.status || null,
        lastReason: stat.reason || null,
        lastDurationMs: stat.durationMs ?? null,
        circuitOpen: Boolean(breaker?.openUntil && breaker.openUntil > this.now()),
        circuitRetryInMs: breaker?.openUntil && breaker.openUntil > this.now()
          ? breaker.openUntil - this.now()
          : 0,
      };
    });
  }

  isEnabled(provider) {
    if (this.enabledOverrides.has(provider.id)) return this.enabledOverrides.get(provider.id);
    return provider.enabled !== false;
  }

  /** Session-scoped enable/disable; environment config is not modified. */
  setEnabled(id, enabled) {
    const provider = this.providers.find((candidate) => candidate.id === id);
    if (!provider) return false;
    this.enabledOverrides.set(id, Boolean(enabled));
    if (!enabled) this.#disconnect(id);
    return true;
  }

  hasProviders() {
    if (!this.enabled) return false;
    return this.providers.some((provider) => this.isEnabled(provider) && provider.configured);
  }

  supports(capability) {
    if (!this.enabled) return false;
    return this.providers.some(
      (provider) =>
        this.isEnabled(provider) &&
        provider.configured &&
        (provider.capabilities?.[capability] ||
          [...this.connections.values()].some((connection) => connection.providerId === provider.id && connection.capabilities?.[capability])),
    );
  }

  #emit(event) {
    if (!this.onEvent) return;
    try {
      this.onEvent({ type: 'webSearch', ...event });
    } catch {
      // A UI failure must never break the search path.
    }
  }

  #record(provider, status, reason, durationMs) {
    this.stats.set(provider.id, { status, reason, durationMs, at: new Date().toISOString() });
    this.logger?.debug('web search provider', {
      provider: provider.id,
      status,
      reason,
      durationMs,
    });
  }

  #breakerOpen(provider) {
    const breaker = this.breakers.get(provider.id);
    if (!breaker?.openUntil) return false;
    if (this.now() >= breaker.openUntil) {
      this.breakers.delete(provider.id);
      return false;
    }
    return true;
  }

  #breakerFailure(provider) {
    const current = this.breakers.get(provider.id) || { failures: 0, openUntil: 0 };
    const failures = current.failures + 1;
    this.breakers.set(provider.id, {
      failures,
      openUntil: failures >= BREAKER_THRESHOLD ? this.now() + BREAKER_COOLDOWN_MS : 0,
    });
  }

  #breakerSuccess(provider) {
    this.breakers.delete(provider.id);
  }

  async #ensureConnection(provider, signal) {
    const existing = this.connections.get(provider.id);
    if (existing) return existing;
    const inflight = this.pending.get(provider.id);
    if (inflight) return inflight;

    const promise = (async () => {
      const connection = await this.connect(provider, { timeoutMs: this.timeoutMs, signal, logger: this.logger });
      const tools = Array.isArray(connection.tools) ? connection.tools : [];
      const mapped = {
        ...connection,
        providerId: provider.id,
        tools,
        capabilities: {
          search: Boolean(pickTool(tools, 'search')),
          extract: Boolean(pickTool(tools, 'extract')),
        },
      };
      this.connections.set(provider.id, mapped);
      return mapped;
    })();
    this.pending.set(provider.id, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(provider.id);
    }
  }

  async #executeOnProvider(provider, capability, input, { signal }) {
    if (provider.kind === 'rest') {
      if (capability !== 'search' || typeof provider.search !== 'function') {
        throw new SearchError(`${provider.label} does not support ${capability}.`, { code: 'MCP_TOOL_MISSING' });
      }
      return provider.search(input, { signal });
    }
    const connection = await this.#ensureConnection(provider, signal);
    const tool = pickTool(connection.tools, capability);
    if (!tool) {
      throw new SearchError(`${provider.label} does not offer a ${capability} tool.`, {
        code: 'MCP_TOOL_MISSING',
        details: { provider: provider.id, capability },
      });
    }
    const args = buildToolArgs(tool, capability, input);
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (signal?.aborted) throw new CancelledError('Task cancelled by user.');
      try {
        const result = await this.callToolImpl(connection, {
          name: tool.name,
          args,
          timeoutMs: this.timeoutMs,
          signal,
        });
        // MCP servers report tool-level failures in-band (isError) instead of
        // as a transport error. Surface them as typed failures so fallback and
        // the UI do not mistake them for an empty result.
        if (result?.isError) {
          const detail = typeof extractPayload(result) === 'string' ? extractPayload(result) : 'MCP tool error';
          const status = Number(String(detail).match(/\b(401|403|429|5\d{2})\b/)?.[1]) || null;
          const code = status === 401 || status === 403
            ? 'MCP_AUTH'
            : status === 429
              ? 'MCP_RATE_LIMIT'
              : status >= 500
                ? 'MCP_UPSTREAM'
                : 'MCP_PROVIDER_ERROR';
          throw new SearchError(`${provider.label} returned an error: ${clean(detail, 200)}`, {
            code,
            status,
            retryable: code === 'MCP_RATE_LIMIT' || code === 'MCP_UPSTREAM',
            details: { provider: provider.id },
          });
        }
        return result;
      } catch (error) {
        lastError = error;
        if (signal?.aborted || error?.code === 'CANCELLED') throw new CancelledError('Task cancelled by user.');
        if (!error?.retryable || attempt === this.maxRetries) break;
        // A rate limit is better served by the next provider than by waiting.
        if (error.status === 429) break;
        const delay = Math.min(2000, 250 * 2 ** attempt) + Math.floor(Math.random() * 100);
        this.logger?.debug('retrying provider', { provider: provider.id, attempt: attempt + 1, delay });
        await this.sleep(delay);
      }
    }
    throw lastError;
  }

  #candidates(capability) {
    return this.providers.filter(
      (provider) =>
        this.isEnabled(provider) &&
        provider.configured &&
        (provider.capabilities?.[capability] || this.connections.get(provider.id)?.capabilities?.[capability]),
    );
  }

  #rows(attempts) {
    return this.providers.map((provider) => {
      const attempt = attempts.find((entry) => entry.id === provider.id);
      if (attempt) return attempt;
      if (!this.isEnabled(provider)) return { id: provider.id, label: provider.label, status: 'skipped', reason: 'dinonaktifkan' };
      if (!provider.configured) return { id: provider.id, label: provider.label, status: 'skipped', reason: 'API key belum dikonfigurasi' };
      return { id: provider.id, label: provider.label, status: 'standby', reason: 'menunggu' };
    });
  }

  #allFailed(capability, attempts, query) {
    const summary = attempts
      .filter((attempt) => attempt.status === 'failed' || attempt.status === 'skipped' || attempt.status === 'empty')
      .map((attempt) => `${attempt.label}: ${attempt.reason}`)
      .join('; ');
    return new SearchError(
      `No web search provider succeeded${summary ? ` (${summary})` : ''}. Continue without web search or retry later.`,
      {
        code: capability === 'extract' ? 'SEARCH_EXTRACT_FAILED' : 'SEARCH_ALL_PROVIDERS_FAILED',
        details: { attempts, query: query ? clean(query, 120) : undefined },
      },
    );
  }

  async search({ query, depth = 'standard' } = {}, { signal = null } = {}) {
    const text = clean(query, MAX_QUERY_CHARS);
    if (!text) throw new ValidationError('query must be a non-empty string.');
    if (!this.enabled) {
      throw new SearchError('Web search is disabled (webSearch.enabled=false).', { code: 'SEARCH_DISABLED' });
    }
    const mode = depth === 'deep' ? 'deep' : 'standard';
    const maxResults = mode === 'deep' ? Math.min(this.maxResults * 2, 10) : this.maxResults;
    const candidates = this.#candidates('search');
    const attempts = [];
    const startedAt = this.now();
    let lastOriginal = null;
    let lastEmpty = null;

    if (candidates.length === 0) {
      const skipped = this.#rows([]).map((row) => ({
        ...row,
        status: 'skipped',
        reason: row.reason === 'menunggu' ? 'tidak tersedia' : row.reason,
      }));
      throw this.#allFailed('search', skipped, text);
    }
    const plan = this.fallbackEnabled ? candidates : candidates.slice(0, 1);

    this.#emit({
      phase: 'start',
      capability: 'search',
      query: text,
      providers: this.list().map((provider) => ({ id: provider.id, label: provider.label, enabled: provider.enabled, configured: provider.configured })),
    });

    for (const provider of plan) {
      if (signal?.aborted) throw new CancelledError('Task cancelled by user.');
      if (this.#breakerOpen(provider)) {
        attempts.push({ id: provider.id, label: provider.label, status: 'skipped', reason: 'circuit breaker terbuka' });
        this.#record(provider, 'skipped', 'circuit breaker terbuka');
        continue;
      }
      this.#emit({ phase: 'attempt', capability: 'search', provider: provider.id, label: provider.label });
      const started = this.now();
      try {
        const result = await this.#executeOnProvider(provider, 'search', { query: text, depth: mode, maxResults }, { signal });
        const durationMs = this.now() - started;
        // REST providers already return the internal shape; MCP providers
        // return a protocol envelope that must be decoded and normalized.
        const normalized = provider.kind === 'rest'
          ? {
              results: Array.isArray(result?.results) ? result.results : [],
              answer_box: result?.answer_box || null,
              people_also_ask: result?.people_also_ask || [],
              related_searches: result?.related_searches || [],
            }
          : normalizeSearchPayload(extractPayload(result), { maxResults });
        if (normalized.results.length === 0) {
          if (provider.kind === 'rest') lastEmpty = { provider, result };
          attempts.push({ id: provider.id, label: provider.label, status: 'empty', reason: 'tidak ada hasil', durationMs });
          this.#record(provider, 'empty', 'tidak ada hasil', durationMs);
          this.#emit({ phase: 'attempt', capability: 'search', provider: provider.id, status: 'empty', durationMs });
          continue;
        }
        this.#breakerSuccess(provider);
        this.#record(provider, 'ok', `${normalized.results.length} hasil`, durationMs);
        attempts.push({ id: provider.id, label: provider.label, status: 'ok', reason: `${normalized.results.length} hasil`, durationMs });
        const output = {
          ...(provider.kind === 'rest' ? result : {}),
          query: text,
          depth: mode,
          provider: provider.id,
          provider_label: provider.label,
          result_count: normalized.results.length,
          results: normalized.results,
          answer_box: normalized.answer_box,
          people_also_ask: normalized.people_also_ask,
          related_searches: normalized.related_searches,
          fallback_used: attempts.filter((attempt) => attempt.status === 'failed').length > 0,
          cached: provider.kind === 'rest' ? Boolean(result?.cached) : false,
          elapsed_ms: provider.kind === 'rest' && result?.cached ? 0 : this.now() - startedAt,
          fetched_at: new Date().toISOString(),
        };
        this.#emit({ phase: 'done', capability: 'search', ok: true, provider: provider.id, rows: this.#rows(attempts), elapsedMs: output.elapsed_ms });
        return output;
      } catch (error) {
        if (error?.code === 'CANCELLED' || signal?.aborted) throw new CancelledError('Task cancelled by user.');
        const durationMs = this.now() - started;
        const reason = failureReason(error);
        lastOriginal = error;
        attempts.push({ id: provider.id, label: provider.label, status: 'failed', reason, durationMs });
        this.#record(provider, 'failed', reason, durationMs);
        this.#breakerFailure(provider);
        this.#emit({ phase: 'attempt', capability: 'search', provider: provider.id, status: 'failed', reason, durationMs });
        this.logger?.warn('web search provider failed', {
          provider: provider.id,
          code: error?.code || null,
          reason,
        });
        if (!this.fallbackEnabled) break;
      }
    }

    const failures = attempts.filter((attempt) => attempt.status === 'failed');
    const rows = this.#rows(attempts);
    if (failures.length === 0 && attempts.some((attempt) => attempt.status === 'empty')) {
      // Every provider answered, just with nothing. Not a provider failure.
      const emptyProvider = lastEmpty?.provider?.id || null;
      this.#emit({ phase: 'done', capability: 'search', ok: true, provider: emptyProvider, rows, elapsedMs: this.now() - startedAt });
      return {
        query: text,
        depth: mode,
        provider: emptyProvider,
        provider_label: lastEmpty?.provider?.label || null,
        ...(lastEmpty?.provider?.kind === 'rest' ? lastEmpty.result : {}),
        result_count: 0,
        results: [],
        answer_box: lastEmpty?.result?.answer_box || null,
        people_also_ask: lastEmpty?.result?.people_also_ask || [],
        related_searches: lastEmpty?.result?.related_searches || [],
        fallback_used: attempts.length > 1,
        cached: Boolean(lastEmpty?.result?.cached),
        elapsed_ms: this.now() - startedAt,
        fetched_at: new Date().toISOString(),
      };
    }
    this.#emit({ phase: 'done', capability: 'search', ok: false, provider: null, rows, elapsedMs: this.now() - startedAt });
    // With one attempted provider, its own actionable error is more useful
    // than a generic "all providers failed" wrapper.
    if (lastOriginal && (plan.length === 1 || !this.fallbackEnabled)) {
      if (lastOriginal instanceof Error) lastOriginal.details = { ...(lastOriginal.details || {}), attempts };
      throw lastOriginal;
    }
    throw this.#allFailed('search', attempts, text);
  }

  async extract({ url, maxChars = 20000 } = {}, { signal = null } = {}) {
    if (!this.enabled) {
      throw new SearchError('Web search is disabled (webSearch.enabled=false).', { code: 'SEARCH_DISABLED' });
    }
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      throw new ValidationError('url must be a valid absolute URL.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new ValidationError('url must be an http(s) URL without credentials.');
    }
    // The provider fetches remotely, but a local/metadata hostname must never
    // be handed to it either.
    await assertPublicUrl(parsed, { resolve: false });
    const target = parsed.toString();
    const candidates = this.#candidates('extract');
    const attempts = [];
    if (candidates.length === 0) {
      throw new SearchError('No configured provider offers page extraction.', { code: 'SEARCH_NO_EXTRACT' });
    }
    const plan = this.fallbackEnabled ? candidates : candidates.slice(0, 1);

    for (const provider of plan) {
      if (signal?.aborted) throw new CancelledError('Task cancelled by user.');
      if (this.#breakerOpen(provider)) {
        attempts.push({ id: provider.id, label: provider.label, status: 'skipped', reason: 'circuit breaker terbuka' });
        continue;
      }
      const started = this.now();
      try {
        const result = await this.#executeOnProvider(provider, 'extract', { url: target }, { signal });
        const normalized = normalizeExtractPayload(extractPayload(result), { url: target });
        const durationMs = this.now() - started;
        if (!normalized.text) {
          attempts.push({ id: provider.id, label: provider.label, status: 'empty', reason: 'halaman kosong', durationMs });
          this.#record(provider, 'empty', 'halaman kosong', durationMs);
          continue;
        }
        this.#breakerSuccess(provider);
        this.#record(provider, 'ok', `${normalized.text.length} chars`, durationMs);
        this.#emit({ phase: 'done', capability: 'extract', ok: true, provider: provider.id, rows: this.#rows(attempts), elapsedMs: durationMs });
        return {
          url: normalized.url || target,
          title: normalized.title,
          text: normalized.text.slice(0, Math.max(1000, Math.min(Number(maxChars) || 20000, 50000))),
          provider: provider.id,
          fetched_at: new Date().toISOString(),
        };
      } catch (error) {
        if (error?.code === 'CANCELLED' || signal?.aborted) throw new CancelledError('Task cancelled by user.');
        const durationMs = this.now() - started;
        const reason = failureReason(error);
        attempts.push({ id: provider.id, label: provider.label, status: 'failed', reason, durationMs });
        this.#record(provider, 'failed', reason, durationMs);
        this.#breakerFailure(provider);
        this.logger?.warn('page extraction failed', { provider: provider.id, code: error?.code || null, reason });
        if (!this.fallbackEnabled) break;
      }
    }
    throw this.#allFailed('extract', attempts, null);
  }

  /** Connection + discovery check only; never runs a billable query. */
  async probe() {
    const rows = [];
    for (const provider of this.providers) {
      if (!this.isEnabled(provider)) {
        rows.push({ id: provider.id, label: provider.label, ok: false, skipped: true, reason: 'dinonaktifkan' });
        continue;
      }
      if (!provider.configured) {
        rows.push({ id: provider.id, label: provider.label, ok: false, skipped: true, reason: 'API key belum dikonfigurasi' });
        continue;
      }
      const started = this.now();
      try {
        const connection = await this.#ensureConnection(provider, null);
        rows.push({
          id: provider.id,
          label: provider.label,
          ok: true,
          durationMs: this.now() - started,
          tools: connection.tools.map((tool) => tool.name).slice(0, 12),
          capabilities: { ...connection.capabilities },
        });
      } catch (error) {
        rows.push({
          id: provider.id,
          label: provider.label,
          ok: false,
          durationMs: this.now() - started,
          reason: failureReason(error),
          code: error?.code || null,
        });
      }
    }
    return rows;
  }

  #disconnect(id) {
    const connection = this.connections.get(id);
    if (!connection) return;
    this.connections.delete(id);
    this.closeConnection(connection).catch(() => {});
  }

  async close() {
    const connections = [...this.connections.values()];
    this.connections.clear();
    this.pending.clear();
    await Promise.all(connections.map((connection) => this.closeConnection(connection).catch(() => {})));
  }
}

export function createWebSearchManager(options = {}) {
  return new WebSearchManager(options);
}
