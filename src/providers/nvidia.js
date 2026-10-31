import OpenAI from 'openai';
import { CancelledError, ProviderError, isRecoverableError } from '../utils/errors.js';
import { redact } from '../utils/redaction.js';
import { toToolArgumentsString } from '../utils/validation.js';
import { MODEL_ID_PATTERN, MAX_MODEL_ID_LENGTH, PROVIDER_REQUEST_FIELDS } from './catalog.js';
import { applyRequestExtras } from './vendor-extras.js';

const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 8000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function abortableSleep(ms, signal) {
  if (!signal) return sleep(ms);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function statusOf(error) {
  return error?.status ?? error?.response?.status ?? null;
}

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']);
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
]);

/**
 * True when a provider failure is worth retrying: the request may succeed on
 * the next attempt (network blip, rate limit, server error) or the failure is
 * known to be repairable locally (a poisoned tool-call payload).
 */
export function isRecoverableProviderError(error) {
  return isRecoverableError(error);
}

/**
 * Walk error.cause (fetch/undici nesting) looking for a known code.
 * The OpenAI SDK v7 wraps connection failures so the code can live two
 * or three levels below the top-level error, with no top-level `code`.
 */
function findCauseCode(error, codes, depth = 0) {
  if (!error || depth > 6) return '';
  const code = String(error.code || '');
  if (codes.has(code)) return code;
  return findCauseCode(error.cause, codes, depth + 1);
}

function causeDetail(error) {
  const messages = [];
  for (let current = error?.cause, depth = 0; current && depth < 4; current = current.cause, depth += 1) {
    if (typeof current.message === 'string' && current.message) messages.push(current.message);
  }
  return messages.join(' / ').slice(0, 300);
}

function retryAfterMs(error) {
  const headers = error?.headers ?? error?.response?.headers;
  let value = null;
  if (headers?.get) value = headers.get('retry-after');
  else if (headers && typeof headers === 'object') value = headers['retry-after'];
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

/** Map raw SDK/network failures onto actionable ProviderError instances. */
export function mapProviderError(error, {
  model,
  providerName = 'NVIDIA',
  apiKeyPath = 'providers.nvidia.apiKey',
  docsUrl = null,
} = {}) {
  if (error instanceof ProviderError) return error;
  if (error instanceof CancelledError) return error;
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return new CancelledError('Request cancelled.');

  const message = redact(String(error?.message || error || 'Unknown provider error')).slice(0, 800);
  const status = statusOf(error);
  const code = String(error?.code || '');
  const errorName = String(error?.constructor?.name || error?.name || '');
  const timeoutCode = findCauseCode(error, TIMEOUT_CODES);
  const networkCode = findCauseCode(error, NETWORK_CODES);
  const lower = message.toLowerCase();
  const modelLabel = model ? `"${model}"` : 'the configured model';
  const where = docsUrl ? ` Verify access on ${docsUrl}.` : '';

  if (errorName === 'APIConnectionTimeoutError' || timeoutCode || /timed? ?out/.test(lower)) {
    return new ProviderError(`The ${providerName} request timed out. ${message}`, {
      code: 'PROVIDER_TIMEOUT',
      retryable: true,
      status,
      cause: error,
    });
  }
  if (errorName === 'APIConnectionError' || networkCode) {
    const detail = causeDetail(error);
    return new ProviderError(
      `Cannot reach the ${providerName} API (${networkCode || 'connection error'}). ${message}${detail ? ` ${detail}` : ''}`,
      { code: 'PROVIDER_NETWORK', retryable: true, status, cause: error },
    );
  }
  if (status === 401) {
    return new ProviderError(
      `${providerName} API authentication failed (401). The key is invalid, revoked, or not loaded. Check ${apiKeyPath} in config.json and run /doctor.`,
      { code: 'AUTH_INVALID', status },
    );
  }
  if (status === 403) {
    return new ProviderError(
      `${providerName} API returned 403 Forbidden. Your key may not have access to ${modelLabel} or the endpoint.${where} ${message}`,
      { code: 'AUTH_FORBIDDEN', status },
    );
  }
  if (status === 404) {
    return new ProviderError(
      `${providerName} API returned 404. ${modelLabel} or the endpoint path may be wrong. Check the model id and base URL (expected .../v1). ${message}`,
      { code: 'MODEL_NOT_FOUND', status },
    );
  }
  if (status === 429) {
    return new ProviderError(
      `${providerName} API rate limit reached (429). Provider-side quotas may apply; wait and retry, or reduce request size. ${message}`,
      { code: 'RATE_LIMIT', status, retryable: true },
    );
  }
  if (status !== null && status >= 500) {
    return new ProviderError(`${providerName} API server error (${status}). This is usually transient. ${message}`, {
      code: 'SERVER_ERROR',
      status,
      retryable: true,
    });
  }
  if (status === 400 || status === 422) {
    if (/context|too many tokens|maximum.*token|token limit|input length/.test(lower)) {
      return new ProviderError(
        `The request exceeded the model context window. Start a new session or reduce context. ${message}`,
        { code: 'CONTEXT_LENGTH', status },
      );
    }
    // The provider validates every `function.arguments` string it receives.
    // A single truncated tool call poisons the whole conversation, so this is
    // recoverable: the history can be repaired and the request replayed.
    if (/function\.arguments|must be a valid JSON object string|tool_calls\[/.test(lower)) {
      return new ProviderError(
        `The provider rejected a tool call in the conversation history because its arguments were not valid JSON. The history has been repaired; the request is being retried. ${message}`,
        { code: 'INVALID_TOOL_ARGUMENTS', status, retryable: true },
      );
    }
    if (/tool|function/.test(lower) && /not (support|available)|unsupported|invalid/.test(lower)) {
      return new ProviderError(
        `${modelLabel} may not support OpenAI-style tool calling on this endpoint. Try a model with tool-call support or use a smaller task. ${message}`,
        { code: 'TOOLS_UNSUPPORTED', status },
      );
    }
    return new ProviderError(`${providerName} API rejected the request (${status}). ${message}`, { code: 'BAD_REQUEST', status });
  }
  return new ProviderError(`Provider request failed: ${message}`, { code: 'PROVIDER_ERROR', status, retryable: false, cause: error });
}

/** Provider-exposed reasoning text (NVIDIA NIM uses `reasoning_content`). */
export function extractReasoning(message = {}) {
  for (const key of ['reasoning_content', 'reasoning']) {
    const value = message?.[key];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

export function normalizeResponse(response, { durationMs = null } = {}) {
  const choice = response?.choices?.[0];
  if (!choice) {
    throw new ProviderError('Provider returned no choices (empty response body).', {
      code: 'EMPTY_RESPONSE',
      retryable: true,
    });
  }
  const message = choice.message || {};
  const toolCalls = (message.tool_calls || []).map((call, index) => ({
    id: call.id || `call_synthetic_${index}_${Date.now()}`,
    name: call.function?.name || '',
    argumentsText: typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments ?? {}),
    type: call.type || 'function',
  })).filter((call) => call.name);

  const usage = response.usage || {};
  return {
    id: response.id || null,
    model: response.model || null,
    content: typeof message.content === 'string' ? message.content : '',
    reasoning: extractReasoning(message),
    toolCalls,
    finishReason: choice.finish_reason || null,
    usage: {
      prompt: usage.prompt_tokens ?? 0,
      completion: usage.completion_tokens ?? 0,
      total: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
    },
    durationMs,
  };
}

/**
 * Accumulate OpenAI-compatible stream chunks. Tool-call names/arguments can be
 * split across chunks and are keyed by their `index`.
 */
export function createStreamAccumulator() {
  return {
    id: null,
    model: null,
    content: '',
    reasoning: '',
    finishReason: null,
    usage: { prompt: 0, completion: 0, total: 0 },
    toolCalls: new Map(),
    choiceChunks: 0,
    emitted: false,
  };
}

export function absorbStreamChunk(acc, chunk, { onReasoning = null, onContent = null } = {}) {
  if (chunk?.id) acc.id = chunk.id;
  if (chunk?.model) acc.model = chunk.model;
  if (chunk?.usage) {
    acc.usage.prompt = chunk.usage.prompt_tokens ?? acc.usage.prompt;
    acc.usage.completion = chunk.usage.completion_tokens ?? acc.usage.completion;
    acc.usage.total = chunk.usage.total_tokens ?? acc.usage.total;
  }
  const choice = chunk?.choices?.[0];
  if (!choice) return;
  acc.choiceChunks += 1;
  if (choice.finish_reason) acc.finishReason = choice.finish_reason;
  const delta = choice.delta || {};
  const reasoningDelta = typeof delta.reasoning_content === 'string'
    ? delta.reasoning_content
    : typeof delta.reasoning === 'string'
      ? delta.reasoning
      : '';
  if (reasoningDelta) {
    acc.reasoning += reasoningDelta;
    acc.emitted = true;
    onReasoning?.(reasoningDelta);
  }
  if (typeof delta.content === 'string' && delta.content) {
    acc.content += delta.content;
    acc.emitted = true;
    onContent?.(delta.content);
  }
  for (const call of delta.tool_calls || []) {
    const index = Number.isInteger(call.index) ? call.index : acc.toolCalls.size;
    const entry = acc.toolCalls.get(index) || { id: null, name: '', argumentsText: '', type: 'function' };
    if (call.id) entry.id = call.id;
    if (call.type) entry.type = call.type;
    if (call.function?.name) entry.name += call.function.name;
    if (typeof call.function?.arguments === 'string') entry.argumentsText += call.function.arguments;
    else if (call.function?.arguments) entry.argumentsText += JSON.stringify(call.function.arguments);
    acc.toolCalls.set(index, entry);
  }
}

export function finalizeStream(acc, { durationMs = null } = {}) {
  if (acc.choiceChunks === 0) {
    throw new ProviderError('Provider stream ended without any choices.', { code: 'EMPTY_RESPONSE', retryable: true });
  }
  const toolCalls = [...acc.toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, call]) => ({
      id: call.id || `call_synthetic_${index}_${Date.now()}`,
      name: call.name,
      argumentsText: call.argumentsText || '{}',
      type: call.type || 'function',
    }))
    .filter((call) => call.name);
  return {
    id: acc.id,
    model: acc.model,
    content: acc.content,
    reasoning: acc.reasoning,
    toolCalls,
    finishReason: acc.finishReason,
    usage: acc.usage,
    durationMs,
  };
}

/**
 * Client for any OpenAI-compatible Chat Completions endpoint.
 *
 * The class name is historical (NVIDIA was the first provider); every provider
 * in the catalog uses it with its own descriptor. `providerName` and
 * `apiKeyPath` only affect user-facing error text — credentials are never
 * printed, and a provider is never called without its own key.
 */
export class NvidiaProvider {
  constructor(config, { client = null, logger = null, fetchImpl = null, sleepImpl = null } = {}) {
    if (!config?.apiKey) {
      const path = config?.apiKeyPath || `providers.${config?.providerId || 'nvidia'}.apiKey`;
      throw new ProviderError(
        `Provider ${config?.providerId || 'nvidia'} has no API key. Set ${path} in config.json (\`ryuu --settings\`) before using it.`,
        { code: 'AUTH_MISSING' },
      );
    }
    this.config = config;
    this.logger = logger;
    this.sleep = sleepImpl || abortableSleep;
    this.fetchImpl = fetchImpl;
    // An injected client is used verbatim (tests); otherwise the SDK client is
    // rebuilt whenever the selection changes.
    this.externalClient = Boolean(client);
    this.client = client || this.#createClient();
  }

  #createClient() {
    return new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseURL,
      timeout: this.config.requestTimeoutMs,
      maxRetries: 0,
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    });
  }

  get model() {
    return this.config.model;
  }

  /** Declared provider capabilities; unknown means "assume the usual". */
  get capabilities() {
    return this.config.capabilities || null;
  }

  /**
   * Extra top-level fields to merge into the request body before it is sent.
   *
   * The OpenAI Chat Completions protocol defines no vendor fields, so the
   * builder comes from `vendor-extras.js`, where a provider module registers
   * itself by id (River's `reasoning_effort`, for example). Registration is by
   * id because one instance is reused across `/provider` switches.
   */
  requestExtras(context = {}) {
    return applyRequestExtras(this.config, { ...context, logger: this.logger });
  }

  get providerId() {
    return this.config.providerId || null;
  }

  get providerName() {
    return this.config.providerName || 'NVIDIA';
  }

  get apiKeyPath() {
    return this.config.apiKeyPath || `providers.${this.providerId || 'nvidia'}.apiKey`;
  }

  /**
   * Repoint this provider at another provider or model without rebuilding the
   * agent (conversation memory and the worklog stay intact).
   */
  updateSelection({ providerId, providerName, apiKeyPath, docsUrl = null, baseURL, apiKey, model, capabilities = null, ...vendor } = {}) {
    if (!apiKey) {
      const path = apiKeyPath || `providers.${providerId || 'unknown'}.apiKey`;
      throw new ProviderError(
        `Provider ${providerId || 'unknown'} has no API key. Set ${path} in config.json before switching.`,
        { code: 'AUTH_MISSING' },
      );
    }
    if (model && (!MODEL_ID_PATTERN.test(model) || model.length > MAX_MODEL_ID_LENGTH)) {
      throw new ProviderError(`Invalid model id: ${JSON.stringify(model)}`, { code: 'INVALID_MODEL' });
    }
    // Mutate in place: the app shares this object as its effective config.
    Object.assign(this.config, {
      providerId: providerId || this.config.providerId,
      providerName: providerName || this.config.providerName,
      apiKeyPath: apiKeyPath || this.config.apiKeyPath,
      docsUrl,
      baseURL: baseURL || this.config.baseURL,
      apiKey,
      model: model || this.config.model,
      capabilities: capabilities || this.config.capabilities || null,
    });
    // Vendor request fields (River's `reasoningEffort`, a pass-through
    // `extraBody`, ...) belong to the provider that is now active. The values
    // of the provider left behind are dropped, so a request never carries a
    // field meant for another endpoint.
    for (const field of PROVIDER_REQUEST_FIELDS) {
      delete this.config[field];
      if (vendor[field] !== undefined) this.config[field] = vendor[field];
    }
    if (!this.externalClient) this.client = this.#createClient();
    return this;
  }

  /**
   * Send a chat completion request with bounded exponential backoff.
   * Never logs the API key or request headers.
   */
  async chat({
    messages,
    tools = [],
    signal = null,
    maxTokens = null,
    stream = false,
    onReasoning = null,
    onContent = null,
    onFirstToken = null,
    stallTimeoutMs = 0,
    timeoutMs = null,
  } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new ProviderError('Cannot call the provider without messages.', { code: 'BAD_REQUEST' });
    }
    // Validate the selection before any bytes leave the machine.
    const selectedModel = String(this.config.model || '');
    if (!selectedModel || !MODEL_ID_PATTERN.test(selectedModel) || selectedModel.length > MAX_MODEL_ID_LENGTH) {
      throw new ProviderError(
        `Invalid model id for provider ${this.config.providerId || 'unknown'}: ${JSON.stringify(this.config.model)}. Pick one with /model (or set the provider's model variable).`,
        { code: 'INVALID_MODEL' },
      );
    }
    const capabilities = this.config.capabilities || null;
    const supportsTools = capabilities?.tools !== false;
    const streaming = Boolean(stream) && capabilities?.streaming !== false;
    if (tools.length > 0 && !supportsTools) {
      this.logger?.warn('provider does not support tool calling; tools are not sent', {
        provider: this.config.providerId,
      });
    }
    // Never let a broken tool-call payload reach the provider: one invalid
    // `function.arguments` string fails the whole request with a 400.
    const sanitized = sanitizeMessagesForRequest(messages);
    if (sanitized.repaired > 0) {
      this.logger?.warn('repaired invalid tool-call arguments before sending', { count: sanitized.repaired });
    }
    const body = {
      model: selectedModel,
      messages: sanitized.messages,
      max_tokens: Math.max(64, Math.min(maxTokens ?? this.config.maxOutputTokens, 32768)),
      stream: streaming,
    };
    if (tools.length > 0 && supportsTools) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    // Vendor extensions (e.g. River's `reasoning_effort`, which turns thinking
    // on for models whose default is off). The base client adds nothing; a
    // provider-specific subclass overrides requestExtras().
    const extras = this.requestExtras({ capabilities, streaming });
    if (extras && typeof extras === 'object') Object.assign(body, extras);

    const startedAt = Date.now();
    const effectiveTimeout = Math.max(1000, Number(timeoutMs ?? this.config.requestTimeoutMs) || 1000);
    let attempt = 0;
    for (;;) {
      if (signal?.aborted) throw new CancelledError();
      let emitted = false;
      let streamedReasoning = '';
      // Per-attempt stream state. Declared outside the inner try so the catch
      // can tell a provider stall apart from a cancellation or a real error.
      let controller = null;
      let stalled = false;
      let stallTimer = null;
      let detachAbort = () => {};
      const clearStall = () => {
        if (stallTimer) {
          clearTimeout(stallTimer);
          stallTimer = null;
        }
      };
      try {
        let normalized;
        if (streaming) {
          const request = {
            ...body,
            stream: true,
            stream_options: { include_usage: true },
          };
          // A stream can stay open indefinitely: the request timeout only
          // covers the request, not a server that dribbles bytes forever. This
          // controller adds a per-chunk idle watchdog on top of the timeout.
          controller = new AbortController();
          if (signal) {
            if (signal.aborted) controller.abort();
            else {
              const onAbort = () => controller.abort();
              signal.addEventListener('abort', onAbort, { once: true });
              detachAbort = () => signal.removeEventListener('abort', onAbort);
            }
          }
          const idleMs = Math.max(0, Number(stallTimeoutMs) || 0);
          const armStall = () => {
            if (!idleMs) return;
            clearStall();
            stallTimer = setTimeout(() => {
              stalled = true;
              controller.abort();
            }, idleMs);
            stallTimer.unref?.();
          };
          armStall();
          const iterator = await this.client.chat.completions.create(request, {
            signal: controller.signal,
            timeout: effectiveTimeout,
          });
          const acc = createStreamAccumulator();
          let firstTokenSeen = false;
          for await (const chunk of iterator) {
            if (signal?.aborted) throw new CancelledError();
            armStall();
            absorbStreamChunk(acc, chunk, {
              onReasoning: (text) => {
                emitted = true;
                streamedReasoning += text;
                onReasoning?.(text);
              },
              onContent: (text) => {
                emitted = true;
                onContent?.(text);
              },
            });
            if (!firstTokenSeen && (acc.emitted || acc.toolCalls.size > 0)) {
              firstTokenSeen = true;
              onFirstToken?.({ latencyMs: Date.now() - startedAt });
            }
          }
          normalized = finalizeStream(acc, { durationMs: Date.now() - startedAt });
        } else {
          const response = await this.client.chat.completions.create(body, {
            signal: signal || undefined,
            timeout: effectiveTimeout,
          });
          normalized = normalizeResponse(response, { durationMs: Date.now() - startedAt });
        }
        this.logger?.debug('provider response', {
          provider: this.config.providerId,
          model: normalized.model,
          stream: streaming,
          toolCalls: normalized.toolCalls.length,
          reasoningChars: (normalized.reasoning || '').length,
          finishReason: normalized.finishReason,
          usage: normalized.usage,
          durationMs: normalized.durationMs,
          attempt,
        });
        return normalized;
      } catch (raw) {
        clearStall();
        detachAbort();
        if (signal?.aborted) throw new CancelledError();
        if (stalled) {
          const seconds = Math.round((Number(stallTimeoutMs) || 0) / 1000);
          this.logger?.warn('provider stream stalled', { attempt, idleSeconds: seconds, emitted });
          throw new ProviderError(
            `The response stream stopped sending data for ${seconds}s and was aborted. The model or endpoint is not responding; nothing was executed.`,
            { code: 'STREAM_STALLED', retryable: !emitted },
          );
        }
        const error = mapProviderError(raw, {
          model: this.config.model,
          providerName: this.providerName,
          apiKeyPath: this.apiKeyPath,
          docsUrl: this.config.docsUrl || null,
        });
        if (emitted) {
          // Retrying after partial output would duplicate reasoning/content.
          this.logger?.warn('provider stream interrupted', { code: error.code, attempt });
          throw new ProviderError(
            `The response stream was interrupted after partial output (${streamedReasoning.length} reasoning chars received); it was not retried to avoid duplicate text. ${error.message}`,
            { code: 'STREAM_INTERRUPTED', retryable: false, status: error.status, cause: error },
          );
        }
        const canRetry = error.retryable && attempt < this.config.maxRetries;
        if (!canRetry) {
          this.logger?.warn('provider request failed', { code: error.code, status: error.status, attempt });
          throw error;
        }
        const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
        const jittered = Math.round(backoff * (0.7 + Math.random() * 0.6));
        const delay = Math.max(jittered, retryAfterMs(raw) ?? 0);
        this.logger?.warn('provider request retry', {
          code: error.code,
          status: error.status,
          attempt: attempt + 1,
          maxRetries: this.config.maxRetries,
          delayMs: delay,
        });
        await this.sleep(delay, signal);
        attempt += 1;
      }
    }
  }

  /** Safe connectivity check. Returns structured status; never prints the key. */
  async ping({ signal = null } = {}) {
    const startedAt = Date.now();
    try {
      const response = await this.chat({
        messages: [
          { role: 'system', content: 'You are a connectivity probe. Reply with exactly: OK' },
          { role: 'user', content: 'Reply with OK.' },
        ],
        maxTokens: 16,
        signal,
      });
      return {
        ok: true,
        model: response.model || this.config.model,
        latencyMs: Date.now() - startedAt,
        sample: (response.content || '').trim().slice(0, 40),
        usage: response.usage,
      };
    } catch (error) {
      return {
        ok: false,
        model: this.config.model,
        latencyMs: Date.now() - startedAt,
        error: { code: error.code || 'PROVIDER_ERROR', message: error.message, status: error.status ?? null },
      };
    }
  }
}

export function createProvider(config, deps = {}) {
  return new NvidiaProvider(config, deps);
}

/**
 * Guarantee that every tool call in the request carries a valid JSON object
 * string.
 *
 * The provider validates the whole conversation on every request, so one
 * truncated payload anywhere in the history makes the request fail with a 400
 * and the task dies. Repairing the payload here is the last line of defence:
 * the agent already sanitizes what it stores, but a session resumed from disk
 * or a plugin-provided message could still carry a broken payload.
 */
export function sanitizeMessagesForRequest(messages = []) {
  let repaired = 0;
  const sanitized = messages.map((message) => {
    if (!message || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) return message;
    const toolCalls = message.tool_calls.map((call) => {
      const fn = call?.function || {};
      const original = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {});
      const fixed = toToolArgumentsString(original);
      if (fixed !== original) repaired += 1;
      return { ...call, function: { ...fn, arguments: fixed } };
    });
    return { ...message, tool_calls: toolCalls };
  });
  return { messages: sanitized, repaired };
}
