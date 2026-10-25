import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { Agent } from '../../src/agent/agent.js';
import { createWebTools } from '../../src/tools/web.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { buildToolRegistry } from '../../src/tools/index.js';
import { Workspace } from '../../src/services/workspace.js';
import { RecordingRenderer, ScriptedProvider, makeTempDir, response, testConfig, toolCall } from '../helpers.js';

const SERPER_PAYLOAD = {
  searchParameters: { q: 'node 25 fetch', type: 'search', num: 5 },
  answerBox: { title: 'Node.js 25', snippet: 'Global fetch is stable.', link: 'https://nodejs.org/' },
  organic: [
    { title: 'Node.js 25 release notes', link: 'https://nodejs.org/en/blog/25', snippet: 'New release line.', date: 'Oct 1, 2026' },
    { title: 'Fetch API docs', link: 'https://developer.mozilla.org/fetch', snippet: 'HTTP requests in JS.' },
    { title: 'No link here', snippet: 'dropped because it has no url' },
  ],
  peopleAlsoAsk: [
    { question: 'Is fetch built in?', snippet: 'Yes, since Node 18.' },
    { question: 'Do I need node-fetch?', snippet: 'No.' },
  ],
  relatedSearches: ['node fetch timeout', 'node fetch proxy'],
  credits: 1,
};

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

async function withTools(overrides, run) {
  const root = await makeTempDir('ryuu-web-');
  try {
    const config = testConfig(root, { webSearchApiKey: 'sk-test-123', ...overrides });
    await run({ config, root });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

async function execute(tools, args, ctx = {}) {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry.execute('web_search', args, ctx);
}

test('normalizes Serper results, answer box and related searches', async () => {
  await withTools({}, async ({ config }) => {
    const fetch = fakeFetch(() => jsonResponse(SERPER_PAYLOAD));
    const tools = createWebTools({ config, fetch });
    assert.equal(tools.length, 1);
    const { result } = await execute(tools, { query: '  node 25 fetch  ' });

    assert.equal(result.query, 'node 25 fetch');
    assert.equal(result.depth, 'standard');
    assert.equal(result.result_count, 2);
    assert.deepEqual(result.results[0], {
      rank: 1,
      title: 'Node.js 25 release notes',
      url: 'https://nodejs.org/en/blog/25',
      snippet: 'New release line.',
      date: 'Oct 1, 2026',
    });
    assert.equal(result.results[1].date, undefined);
    assert.equal(result.answer_box.text, 'Global fetch is stable.');
    assert.equal(result.answer_box.url, 'https://nodejs.org/');
    assert.deepEqual(result.people_also_ask.map((item) => item.question), ['Is fetch built in?', 'Do I need node-fetch?']);
    assert.deepEqual(result.related_searches, ['node fetch timeout', 'node fetch proxy']);
    assert.equal(result.credits, 1);
    assert.equal(result.cached, false);
    assert.equal(result.endpoint, 'google.serper.dev');

    const [{ url, init }] = fetch.calls;
    assert.equal(url, 'https://google.serper.dev/search');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['X-API-KEY'], 'sk-test-123');
    assert.equal(init.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(init.body), { q: 'node 25 fetch', num: 5, gl: 'us', hl: 'en' });
  });
});

test('deep depth doubles the result count and caps it at 10', async () => {
  await withTools({ webSearchResults: 8 }, async ({ config }) => {
    const fetch = fakeFetch(() => jsonResponse(SERPER_PAYLOAD));
    const tools = createWebTools({ config, fetch });
    await execute(tools, { query: 'x', depth: 'deep' });
    assert.equal(JSON.parse(fetch.calls[0].init.body).num, 10);

    const results = await execute(tools, { query: 'y', depth: 'deep' });
    assert.equal(results.result.depth, 'deep');
  });
});

test('an identical query is served from cache instead of paying twice', async () => {
  await withTools({}, async ({ config }) => {
    const fetch = fakeFetch(() => jsonResponse(SERPER_PAYLOAD));
    const tools = createWebTools({ config, fetch });
    const first = await execute(tools, { query: 'node 25 fetch' });
    const second = await execute(tools, { query: 'NODE   25 fetch' });
    assert.equal(fetch.calls.length, 1);
    assert.equal(first.result.cached, false);
    assert.equal(second.result.cached, true);
    assert.equal(second.result.elapsed_ms, 0);

    // A different depth is a different search.
    await execute(tools, { query: 'node 25 fetch', depth: 'deep' });
    assert.equal(fetch.calls.length, 2);
  });
});

test('the cache is bounded and an evicted query is fetched again', async () => {
  await withTools({}, async ({ config }) => {
    const fetch = fakeFetch(() => jsonResponse(SERPER_PAYLOAD));
    const tools = createWebTools({ config, fetch });
    for (let index = 0; index <= 20; index += 1) {
      await execute(tools, { query: `query ${index}` });
    }
    assert.equal(fetch.calls.length, 21);

    // 20 entries are retained, so the oldest query was evicted and is paid for again.
    const again = await execute(tools, { query: 'query 0' });
    assert.equal(fetch.calls.length, 22);
    assert.equal(again.result.cached, false);

    const recent = await execute(tools, { query: 'query 20' });
    assert.equal(recent.result.cached, true);
    assert.equal(fetch.calls.length, 22);
  });
});

test('rejects an empty and an oversized response body', async () => {
  await withTools({}, async ({ config }) => {
    const empty = fakeFetch(() => jsonResponse(''));
    await assert.rejects(
      execute(createWebTools({ config, fetch: empty }), { query: 'empty' }),
      (error) => error.code === 'SEARCH_BAD_RESPONSE' && /empty JSON body/.test(error.message),
    );

    const oversized = fakeFetch(() => jsonResponse('x'.repeat(2 * 1024 * 1024 + 1)));
    await assert.rejects(
      execute(createWebTools({ config, fetch: oversized }), { query: 'huge' }),
      (error) => error.code === 'SEARCH_BAD_RESPONSE' && /oversized/.test(error.message),
    );
  });
});

test('accepts alternate SERP JSON dialects (organic_results / answer_box)', async () => {
  await withTools({}, async ({ config }) => {
    const payload = {
      organic_results: [{ title: 'Alt', link: 'https://example.com/alt', description: 'alt snippet' }],
      answer_box: { answer: 'alt answer' },
      related_questions: [{ question: 'alt question?' }],
      related_searches: [{ query: 'alt related' }],
    };
    const tools = createWebTools({ config, fetch: fakeFetch(() => jsonResponse(payload)) });
    const { result } = await execute(tools, { query: 'alt' });
    assert.equal(result.results[0].snippet, 'alt snippet');
    assert.equal(result.answer_box.text, 'alt answer');
    assert.equal(result.people_also_ask[0].question, 'alt question?');
    assert.deepEqual(result.related_searches, ['alt related']);
  });
});

test('rejects an empty or oversized query before spending a request', async () => {
  await withTools({}, async ({ config }) => {
    const fetch = fakeFetch(() => jsonResponse(SERPER_PAYLOAD));
    const tools = createWebTools({ config, fetch });
    await assert.rejects(execute(tools, { query: '   ' }), (error) => error.code === 'VALIDATION_FAILED');
    await assert.rejects(execute(tools, { query: 'a'.repeat(401) }), (error) => error.code === 'VALIDATION_FAILED');
    assert.equal(fetch.calls.length, 0);

    // Within the bound the query is sent with whitespace collapsed.
    await execute(tools, { query: `${'a'.repeat(198)}   ${'b'.repeat(198)}` });
    assert.equal(JSON.parse(fetch.calls[0].init.body).q, `${'a'.repeat(198)} ${'b'.repeat(198)}`);
  });
});

test('maps search API failures to actionable codes', async () => {
  const cases = [
    [401, 'SEARCH_AUTH'],
    [403, 'SEARCH_AUTH'],
    [402, 'SEARCH_RATE_LIMIT'],
    [429, 'SEARCH_RATE_LIMIT'],
    [500, 'SEARCH_UPSTREAM'],
    [418, 'SEARCH_FAILED'],
  ];
  await withTools({}, async ({ config }) => {
    for (const [status, code] of cases) {
      const tools = createWebTools({ config, fetch: fakeFetch(() => jsonResponse({}, status)) });
      await assert.rejects(
        execute(tools, { query: `status ${status}` }),
        (error) => error.code === code && error.status === status,
        `expected ${status} -> ${code}`,
      );
    }
  });
});

test('reports a network failure, a timeout and a non-JSON body', async () => {
  await withTools({}, async ({ config }) => {
    const network = fakeFetch(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND google.serper.dev') });
    });
    await assert.rejects(
      execute(createWebTools({ config, fetch: network }), { query: 'offline' }),
      (error) => error.code === 'SEARCH_NETWORK' && /ENOTFOUND/.test(error.message),
    );

    const notJson = fakeFetch(() => jsonResponse('<html>gateway</html>'));
    await assert.rejects(
      execute(createWebTools({ config, fetch: notJson }), { query: 'html' }),
      (error) => error.code === 'SEARCH_BAD_RESPONSE',
    );

    // A client that honours the abort signal turns the timeout into SEARCH_TIMEOUT.
    const stalling = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const started = Date.now();
    await assert.rejects(
      execute(createWebTools({ config: { ...config, webSearchTimeoutMs: 1000 }, fetch: stalling }), { query: 'slow' }),
      (error) => error.code === 'SEARCH_TIMEOUT',
    );
    assert.ok(Date.now() - started >= 900, 'timeout should wait for the configured budget');
  });
});

test('an aborted task cancels the search instead of waiting for the timeout', async () => {
  await withTools({}, async ({ config }) => {
    const controller = new AbortController();
    const stalling = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      setTimeout(() => controller.abort(), 20);
    });
    const tools = createWebTools({ config, fetch: stalling });
    await assert.rejects(
      execute(tools, { query: 'cancel me' }, { signal: controller.signal }),
      (error) => error.code === 'CANCELLED',
    );
  });
});

test('supports Authorization: Bearer providers', async () => {
  await withTools({ webSearchAuthHeader: 'Authorization', webSearchEndpoint: 'https://api.example.dev/serp' }, async ({ config }) => {
    const fetch = fakeFetch(() => jsonResponse({ organic: [] }));
    const tools = createWebTools({ config, fetch });
    const { result } = await execute(tools, { query: 'bearer' });
    assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer sk-test-123');
    assert.equal(fetch.calls[0].init.headers['X-API-KEY'], undefined);
    assert.equal(result.endpoint, 'api.example.dev');
    assert.equal(result.result_count, 0);
  });
});

test('agent calls web_search end to end and keeps the finding in the worklog', async (t) => {
  const root = await makeTempDir('ryuu-web-agent-');
  try {
    const workspace = new Workspace(root);
    const config = testConfig(root, { webSearchApiKey: 'sk-test-123' });
    const registry = buildToolRegistry({ workspace, config });
    const provider = new ScriptedProvider([
      response({ toolCalls: [toolCall('web_search', { query: 'node 25 fetch' })] }),
      response({ content: 'Node 25 ships global fetch (https://nodejs.org/en/blog/25).' }),
    ]);
    const renderer = new RecordingRenderer();
    const agent = new Agent({ provider, registry, workspace, config, renderer });
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse(SERPER_PAYLOAD));

    const summary = await agent.run('is fetch built into node 25?');

    assert.equal(summary.status, 'completed');
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.ok(provider.calls[0].tools.some((entry) => entry.function.name === 'web_search'));
    assert.match(provider.calls[0].messages[0].content, /web_search/);

    const toolMessage = provider.calls[1].messages.find((message) => message.role === 'tool');
    const payload = JSON.parse(toolMessage.content);
    assert.equal(payload.ok, true);
    assert.equal(payload.result.results[0].url, 'https://nodejs.org/en/blog/25');
    assert.equal(payload.result.answer_box.text, 'Global fetch is stable.');

    const feed = renderer.events.find((event) => event.event === 'toolEnd' && event.payload.name === 'web_search');
    assert.equal(feed.payload.ok, true);
    assert.match(feed.payload.summary, /2 result\(s\) for "node 25 fetch"/);
    assert.match(agent.getWorklog().brief(), /web_search "node 25 fetch" -> 2 result\(s\)/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('the tool is absent without a key and registered as a read tool with one', async () => {
  const root = await makeTempDir('ryuu-web-registry-');
  try {
    const workspace = new Workspace(root);
    const disabled = buildToolRegistry({ workspace, config: testConfig(root) });
    assert.equal(disabled.has('web_search'), false);

    const enabled = buildToolRegistry({ workspace, config: testConfig(root, { webSearchApiKey: 'sk-test-123' }) });
    const tool = enabled.get('web_search');
    assert.equal(tool.risk, 'read');
    assert.equal(tool.requiresApproval, false);
    assert.deepEqual(tool.schema.required, ['query']);

    const schemas = enabled.toOpenAITools().map((entry) => entry.function.name);
    assert.ok(schemas.includes('web_search'));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
