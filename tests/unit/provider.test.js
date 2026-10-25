import test from 'node:test';
import assert from 'node:assert/strict';
import { NvidiaProvider, mapProviderError, normalizeResponse, sanitizeMessagesForRequest } from '../../src/providers/nvidia.js';
import { makeTempDir, testConfig } from '../helpers.js';
import { CancelledError } from '../../src/utils/errors.js';

function fakeClient(create) {
  return { chat: { completions: { create } } };
}

async function withConfig(fn, overrides = {}) {
  const root = await makeTempDir('ryuu-provider-');
  try {
    const config = testConfig(root, { maxRetries: 0, ...overrides });
    await fn({ config, root });
  } finally {
    const fsp = await import('node:fs/promises');
    await fsp.rm(root, { recursive: true, force: true });
  }
}

const successResponse = {
  id: 'chatcmpl-1',
  model: 'deepseek-ai/deepseek-v4.1-flash',
  choices: [{
    message: {
      role: 'assistant',
      content: 'hello',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }],
    },
    finish_reason: 'tool_calls',
  }],
  usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
};

test('normalizes chat completions and tool calls', () => {  const normalized = normalizeResponse(successResponse, { durationMs: 5 });
  assert.equal(normalized.content, 'hello');
  assert.equal(normalized.toolCalls.length, 1);
  assert.equal(normalized.toolCalls[0].name, 'read_file');
  assert.equal(normalized.toolCalls[0].argumentsText, '{"path":"a.js"}');
  assert.deepEqual(normalized.usage, { prompt: 12, completion: 7, total: 19 });
});

test('normalizes missing tool call ids and rejects empty choices', () => {
  const response = structuredClone(successResponse);
  delete response.choices[0].message.tool_calls[0].id;
  const normalized = normalizeResponse(response);
  assert.match(normalized.toolCalls[0].id, /^call_synthetic_/);
  assert.throws(() => normalizeResponse({ choices: [] }), (error) => error.code === 'EMPTY_RESPONSE');
});

test('maps provider errors to actionable codes without leaking keys', () => {
  const auth = mapProviderError(Object.assign(new Error('Invalid key nvapi-supersecretvalue'), { status: 401 }));
  assert.equal(auth.code, 'AUTH_INVALID');
  assert.equal(auth.retryable, false);
  assert.ok(!auth.message.includes('nvapi-supersecretvalue'));

  const rate = mapProviderError(Object.assign(new Error('rate limited'), { status: 429 }));
  assert.equal(rate.code, 'RATE_LIMIT');
  assert.equal(rate.retryable, true);

  const context = mapProviderError(Object.assign(new Error('maximum context length exceeded'), { status: 400 }));
  assert.equal(context.code, 'CONTEXT_LENGTH');
  assert.equal(context.retryable, false);

  const tools = mapProviderError(Object.assign(new Error('tool calling is not supported by this model'), { status: 400 }));
  assert.equal(tools.code, 'TOOLS_UNSUPPORTED');

  const network = mapProviderError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
  assert.equal(network.code, 'PROVIDER_NETWORK');
  assert.equal(network.retryable, true);

  const notFound = mapProviderError(Object.assign(new Error('model not found'), { status: 404 }));
  assert.equal(notFound.code, 'MODEL_NOT_FOUND');
});

test('maps real OpenAI SDK connection error shapes (v7 sets no top-level code)', () => {
  class APIConnectionError extends Error {}
  const fetchFailure = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }),
  });
  const sdkError = new APIConnectionError('Connection error.');
  sdkError.cause = fetchFailure;

  const mapped = mapProviderError(sdkError, { model: 'test/model' });
  assert.equal(mapped.code, 'PROVIDER_NETWORK');
  assert.equal(mapped.retryable, true);
  assert.match(mapped.message, /ECONNREFUSED/);
  assert.match(mapped.message, /fetch failed/);

  class APIConnectionTimeoutError extends Error {}
  const timeout = mapProviderError(new APIConnectionTimeoutError('Request timed out.'));
  assert.equal(timeout.code, 'PROVIDER_TIMEOUT');
  assert.equal(timeout.retryable, true);

  const nestedResolve = mapProviderError(Object.assign(new Error('Connection error.'), {
    cause: Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND integrate.api.nvidia.com'), { code: 'ENOTFOUND' }),
    }),
  }));
  assert.equal(nestedResolve.code, 'PROVIDER_NETWORK');
});

test('streams provider reasoning and assembles fragmented tool calls', async () => {
  await withConfig(async ({ config }) => {
    let capturedBody = null;
    const chunks = [
      { id: 'chatcmpl-stream', model: 'test/model', choices: [{ delta: { role: 'assistant', reasoning_content: 'think ' }, finish_reason: null }] },
      { id: 'chatcmpl-stream', model: 'test/model', choices: [{ delta: { reasoning_content: '42' }, finish_reason: null }] },
      { id: 'chatcmpl-stream', model: 'test/model', choices: [{ delta: { content: 'OK' }, finish_reason: null }] },
      { id: 'chatcmpl-stream', model: 'test/model', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] }, finish_reason: null }] },
      { id: 'chatcmpl-stream', model: 'test/model', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.js"}' } }] }, finish_reason: 'tool_calls' }] },
      { id: 'chatcmpl-stream', model: 'test/model', choices: [], usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 } },
    ];
    const client = fakeClient(async (body) => {
      capturedBody = body;
      return (async function* () { for (const chunk of chunks) yield chunk; })();
    });
    const provider = new NvidiaProvider(config, { client });
    const reasoning = [];
    const content = [];
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
      stream: true,
      onReasoning: (text) => reasoning.push(text),
      onContent: (text) => content.push(text),
    });

    assert.equal(capturedBody.stream, true);
    assert.deepEqual(capturedBody.stream_options, { include_usage: true });
    assert.deepEqual(reasoning, ['think ', '42']);
    assert.deepEqual(content, ['OK']);
    assert.equal(result.reasoning, 'think 42');
    assert.equal(result.content, 'OK');
    assert.equal(result.finishReason, 'tool_calls');
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'read_file');
    assert.equal(result.toolCalls[0].argumentsText, '{"path":"a.js"}');
    assert.deepEqual(result.usage, { prompt: 5, completion: 9, total: 14 });
  });
});

test('does not retry a stream after partial output, but retries before output', async () => {
  await withConfig(async ({ config }) => {
    let calls = 0;
    const partialClient = fakeClient(async () => {
      calls += 1;
      return (async function* () {
        yield { choices: [{ delta: { content: 'partial' }, finish_reason: null }] };
        throw Object.assign(new Error('upstream failed'), { status: 500 });
      })();
    });
    const partialProvider = new NvidiaProvider(config, {
      client: partialClient,
      sleepImpl: async () => {},
    });
    await assert.rejects(
      partialProvider.chat({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
      (error) => error.code === 'STREAM_INTERRUPTED' && error.retryable === false,
    );
    assert.equal(calls, 1);

    let retryCalls = 0;
    const retryClient = fakeClient(async () => {
      retryCalls += 1;
      if (retryCalls === 1) {
        return (async function* () {
          throw Object.assign(new Error('rate limited'), { status: 429 });
        })();
      }
      return (async function* () {
        yield { choices: [{ delta: { content: 'recovered' }, finish_reason: 'stop' }] };
      })();
    });
    const retryProvider = new NvidiaProvider(config, {
      client: retryClient,
      sleepImpl: async () => {},
    });
    const result = await retryProvider.chat({ messages: [{ role: 'user', content: 'hi' }], stream: true });
    assert.equal(result.content, 'recovered');
    assert.equal(retryCalls, 2);
  }, { maxRetries: 2 });
});

test('calls the real OpenAI SDK with an injected fetch (no network)', async () => {
  await withConfig(async ({ config }) => {
    const captured = [];
    const fetchImpl = async (url, init) => {
      captured.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify(successResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const provider = new NvidiaProvider(config, { fetchImpl });
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{
        type: 'function',
        function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } },
      }],
    });
    assert.equal(captured.length, 1);
    assert.match(captured[0].url, /\/chat\/completions$/);
    assert.equal(captured[0].body.model, config.model);
    assert.equal(captured[0].body.stream, false);
    assert.equal(captured[0].body.tool_choice, 'auto');
    assert.equal(captured[0].body.max_tokens, config.maxOutputTokens);
    assert.equal(result.toolCalls[0].name, 'read_file');
    assert.equal(result.content, 'hello');
  });
});

test('retries rate limits with backoff and eventually succeeds', async () => {
  await withConfig(async ({ config }) => {
    let attempts = 0;
    const delays = [];
    const client = fakeClient(async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('rate limited'), { status: 429 });
      return successResponse;
    });
    const provider = new NvidiaProvider(config, {
      client,
      sleepImpl: async (ms) => { delays.push(ms); },
    });
    const result = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(attempts, 3);
    assert.equal(delays.length, 2);
    assert.ok(delays.every((delay) => delay > 0 && delay <= 8000));
    assert.equal(result.content, 'hello');
  }, { maxRetries: 2 });
});

test('honors Retry-After when present and stops at the retry limit', async () => {
  await withConfig(async ({ config }) => {
    const delays = [];
    let calls = 0;
    const client = fakeClient(async () => {
      calls += 1;
      throw Object.assign(new Error('too many requests'), { status: 429, headers: { 'retry-after': '1' } });
    });
    const provider = new NvidiaProvider(config, {
      client,
      sleepImpl: async (ms) => { delays.push(ms); },
    });
    await assert.rejects(
      provider.chat({ messages: [{ role: 'user', content: 'hi' }] }),
      (error) => error.code === 'RATE_LIMIT',
    );
    assert.equal(calls, 3);
    assert.equal(delays.length, 2);
    assert.ok(delays.every((delay) => delay >= 1000), `delays: ${delays.join(',')}`);
  }, { maxRetries: 2 });
});

test('does not retry authentication or context errors', async () => {
  await withConfig(async ({ config }) => {
    let calls = 0;
    const client = fakeClient(async () => {
      calls += 1;
      throw Object.assign(new Error('Invalid API key'), { status: 401 });
    });
    const provider = new NvidiaProvider(config, { client, sleepImpl: async () => {} });
    await assert.rejects(provider.chat({ messages: [{ role: 'user', content: 'hi' }] }), (error) => error.code === 'AUTH_INVALID');
    assert.equal(calls, 1);
  }, { maxRetries: 3 });
});

test('reports SDK HTTP errors through the real client path', async () => {
  await withConfig(async ({ config }) => {
    const fetchImpl = async () => new Response(
      JSON.stringify({ error: { message: 'Invalid key nvapi-should-not-leak', type: 'invalid_request_error' } }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    );
    const provider = new NvidiaProvider(config, { fetchImpl });
    await assert.rejects(
      provider.chat({ messages: [{ role: 'user', content: 'hi' }] }),
      (error) => error.code === 'AUTH_INVALID' && !error.message.includes('nvapi-should-not-leak'),
    );
  });
});

test('throws before calling the API when the signal is already aborted', async () => {
  await withConfig(async ({ config }) => {
    let calls = 0;
    const provider = new NvidiaProvider(config, { client: fakeClient(async () => { calls += 1; return successResponse; }) });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(provider.chat({ messages: [{ role: 'user', content: 'hi' }], signal: controller.signal }), CancelledError);
    assert.equal(calls, 0);
  });
});

test('ping reports success and failure without throwing', async () => {
  await withConfig(async ({ config }) => {
    const okProvider = new NvidiaProvider(config, {
      client: fakeClient(async () => ({ ...successResponse, choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })),
    });
    const ok = await okProvider.ping();
    assert.equal(ok.ok, true);
    assert.equal(ok.sample, 'OK');

    const badProvider = new NvidiaProvider(config, {
      client: fakeClient(async () => { throw Object.assign(new Error('nope'), { status: 401 }); }),
    });
    const bad = await badProvider.ping();
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, 'AUTH_INVALID');
  });
});

test('a broken tool call in the history is repaired before the request goes out', () => {
  const messages = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'run_command', arguments: '{"argv":["grep","-rn","x","src",' } },
        { id: 'call_2', type: 'function', function: { name: 'read_file', arguments: 'totally broken' } },
        { id: 'call_3', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } },
      ],
    },
  ];
  const { messages: sanitized, repaired } = sanitizeMessagesForRequest(messages);
  assert.equal(repaired, 2);
  for (const call of sanitized[1].tool_calls) {
    assert.equal(typeof call.function.arguments, 'string');
    assert.doesNotThrow(() => JSON.parse(call.function.arguments));
  }
  assert.deepEqual(JSON.parse(sanitized[1].tool_calls[0].function.arguments).argv, ['grep', '-rn', 'x', 'src']);
  assert.equal(sanitized[1].tool_calls[1].function.arguments, '{}');
  assert.equal(sanitized[1].tool_calls[2].function.arguments, '{"path":"a.js"}');
  // The original messages are not mutated.
  assert.equal(messages[1].tool_calls[0].function.arguments, '{"argv":["grep","-rn","x","src",');
});

test('the provider sends a sanitized history to the API', async () => {
  await withConfig(async ({ config }) => {
    let sent = null;
    const provider = new NvidiaProvider(config, {
      client: fakeClient(async (request) => {
        sent = request;
        return { ...successResponse, choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };
      }),
    });
    await provider.chat({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"' } }],
        },
      ],
    });
    const call = sent.messages.find((message) => message.role === 'assistant');
    assert.doesNotThrow(() => JSON.parse(call.tool_calls[0].function.arguments));
    assert.deepEqual(JSON.parse(call.tool_calls[0].function.arguments), { path: 'a.js' });
  });
});

test('a rejected tool-call payload is reported as a recoverable error', () => {
  const error = mapProviderError(Object.assign(new Error(
    '400 Validation: `messages[17].tool_calls[1].function.arguments` must be a valid JSON object string: EOF while parsing a value',
  ), { status: 400 }));
  assert.equal(error.code, 'INVALID_TOOL_ARGUMENTS');
  assert.equal(error.retryable, true);
});

test('reports first-token latency once per streamed response', async () => {
  await withConfig(async ({ config }) => {
    const chunks = [
      { id: 'c1', model: 'test/model', choices: [{ delta: { reasoning_content: 'hmm' }, finish_reason: null }] },
      { id: 'c1', model: 'test/model', choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] },
    ];
    const client = fakeClient(async () => (async function* () { for (const chunk of chunks) yield chunk; })());
    const provider = new NvidiaProvider(config, { client });
    const seen = [];
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      onFirstToken: (payload) => seen.push(payload),
    });
    assert.equal(seen.length, 1, 'the first token is reported exactly once');
    assert.ok(seen[0].latencyMs >= 0);
    assert.equal(result.content, 'done');
  });
});

test('aborts a stream that stops producing bytes and reports STREAM_STALLED', async () => {
  await withConfig(async ({ config }) => {
    const client = fakeClient(async (_body, options = {}) => {
      const signal = options.signal;
      return (async function* () {
        yield { id: 'c1', model: 'test/model', choices: [{ delta: { content: 'partial' }, finish_reason: null }] };
        await new Promise((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        });
      })();
    });
    const provider = new NvidiaProvider(config, { client });
    await assert.rejects(
      () => provider.chat({
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stallTimeoutMs: 60,
      }),
      (error) => {
        assert.equal(error.code, 'STREAM_STALLED');
        assert.equal(error.retryable, false, 'partial output is never retried');
        assert.match(error.message, /stopped sending data/);
        return true;
      },
    );
  });
});
