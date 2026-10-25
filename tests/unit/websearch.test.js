import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSearchManager } from '../../src/services/websearch/manager.js';
import { buildToolArgs, pickTool } from '../../src/services/websearch/manager.js';
import {
  canonicalUrl,
  normalizeExtractPayload,
  normalizeSearchPayload,
} from '../../src/services/websearch/normalize.js';
import { createWebTools } from '../../src/tools/web.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { SearchError } from '../../src/utils/errors.js';
import { makeTempDir, testConfig } from '../helpers.js';

const SEARCH_TOOL = {
  name: 'x_search',
  description: 'Search the public web',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'number' },
    },
    required: ['query'],
  },
};

const EXTRACT_TOOL = {
  name: 'x_scrape',
  description: 'Scrape a page into markdown',
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string' }, formats: { type: 'array' } },
    required: ['url'],
  },
};

function provider(id, overrides = {}) {
  return {
    id,
    label: id,
    kind: 'mcp',
    transport: 'streamable-http',
    url: `https://${id}.example/mcp`,
    headers: {},
    requiresKey: false,
    configured: true,
    enabled: true,
    capabilities: { search: true, extract: true },
    ...overrides,
  };
}

function mcpText(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function rows(urls) {
  return {
    results: urls.map((url, index) => ({
      title: `Title ${index + 1}`,
      url,
      snippet: `Snippet ${index + 1}`,
    })),
  };
}

function setup(specs) {
  const calls = { connect: [], call: [], close: [] };
  const connect = async (target) => {
    calls.connect.push(target.id);
    const spec = specs[target.id] || {};
    if (spec.connectError) throw spec.connectError;
    return { client: {}, tools: spec.tools || [SEARCH_TOOL] };
  };
  const callTool = async (connection, { name, args }) => {
    calls.call.push({ provider: connection.providerId, name, args });
    const spec = specs[connection.providerId] || {};
    if (spec.errors?.length) throw spec.errors.shift();
    if (spec.respond) return spec.respond({ name, args });
    return mcpText(rows(['https://a.example/a']));
  };
  const closeConnection = async (connection) => {
    calls.close.push(connection.providerId);
  };
  return { connect, callTool, closeConnection, calls };
}

function managerFor(providers, specs, overrides = {}) {
  const fake = setup(specs);
  const manager = new WebSearchManager({
    config: {
      webSearchEnabled: true,
      webSearchFallback: true,
      webSearchResults: 5,
      webMcpTimeoutMs: 1000,
      webMcpMaxRetries: 0,
      ...overrides,
    },
    providers,
    connect: fake.connect,
    callTool: fake.callTool,
    closeConnection: fake.closeConnection,
    sleep: async () => {},
    ...(overrides.managerOptions || {}),
  });
  return { manager, calls: fake.calls };
}

test('primary provider succeeds and its results reach the caller', async () => {
  const { manager, calls } = managerFor(
    [provider('you'), provider('firecrawl')],
    {
      you: { respond: () => ({ structuredContent: { results: { web: rows(['https://a.example/a']).results } } }) },
    },
  );
  const result = await manager.search({ query: 'mcp client' });
  assert.equal(result.provider, 'you');
  assert.equal(result.result_count, 1);
  assert.equal(result.results[0].url, 'https://a.example/a');
  assert.equal(result.results[0].snippet, 'Snippet 1');
  assert.equal(result.fallback_used, false);
  assert.deepEqual(calls.connect, ['you']);
});

test('primary timeout falls through to the second provider', async () => {
  const { manager, calls } = managerFor(
    [provider('you'), provider('firecrawl')],
    {
      you: { connectError: new SearchError('You.com timed out', { code: 'MCP_TIMEOUT', retryable: true }) },
      firecrawl: { respond: () => mcpText({ data: { web: rows(['https://f.example/doc']).results } }) },
    },
  );
  const result = await manager.search({ query: 'node 25 fetch' });
  assert.equal(result.provider, 'firecrawl');
  assert.equal(result.fallback_used, true);
  assert.equal(result.results[0].url, 'https://f.example/doc');
  assert.deepEqual(calls.connect, ['you', 'firecrawl']);
});

test('HTTP 429 is not retried in a loop and falls back immediately', async () => {
  const { manager, calls } = managerFor(
    [provider('you'), provider('firecrawl')],
    {
      you: { errors: [new SearchError('rate limited', { code: 'MCP_RATE_LIMIT', status: 429, retryable: true })] },
    },
    { webMcpMaxRetries: 3 },
  );
  const result = await manager.search({ query: 'rate limit test' });
  assert.equal(result.provider, 'firecrawl');
  assert.equal(calls.call.filter((call) => call.provider === 'you').length, 1);
});

test('a provider that needs a key is skipped, never connected', async () => {
  const { manager, calls } = managerFor(
    [provider('tavily', { requiresKey: true, configured: false }), provider('you')],
    {},
  );
  const result = await manager.search({ query: 'skip missing key' });
  assert.equal(result.provider, 'you');
  assert.deepEqual(calls.connect, ['you']);
  assert.equal(manager.list().find((item) => item.id === 'tavily').configured, false);
});

test('when no provider is configured the error names the missing key', async () => {
  const { manager, calls } = managerFor([provider('tavily', { requiresKey: true, configured: false })], {});
  assert.equal(manager.hasProviders(), false);
  await assert.rejects(manager.search({ query: 'nothing' }), (error) => {
    assert.equal(error.code, 'SEARCH_ALL_PROVIDERS_FAILED');
    assert.match(error.message, /API key belum dikonfigurasi/);
    return true;
  });
  assert.deepEqual(calls.connect, []);
});

test('MCP handshake failure falls back to the next provider', async () => {
  const { manager } = managerFor(
    [provider('you'), provider('firecrawl')],
    { you: { connectError: new SearchError('handshake failed', { code: 'MCP_HANDSHAKE' }) } },
  );
  const result = await manager.search({ query: 'handshake' });
  assert.equal(result.provider, 'firecrawl');
});

test('a discovered provider without a search tool is skipped', async () => {
  const { manager } = managerFor(
    [provider('you'), provider('firecrawl')],
    { you: { tools: [{ name: 'weather', description: 'weather lookup', inputSchema: { type: 'object', properties: {} } }] } },
  );
  const result = await manager.search({ query: 'tool mapping' });
  assert.equal(result.provider, 'firecrawl');
  assert.equal(manager.list().find((item) => item.id === 'you').lastReason, 'tool tidak tersedia');
});

test('an empty but valid result may try the next provider and never throws', async () => {
  const { manager } = managerFor(
    [provider('you'), provider('firecrawl')],
    { you: { respond: () => mcpText({ results: [] }) } },
  );
  const result = await manager.search({ query: 'empty first' });
  assert.equal(result.provider, 'firecrawl');
  assert.equal(result.result_count, 1);

  const onlyEmpty = managerFor([provider('you')], {
    you: { respond: () => mcpText({ results: [] }) },
  }).manager;
  const empty = await onlyEmpty.search({ query: 'empty all' });
  assert.equal(empty.result_count, 0);
  assert.deepEqual(empty.results, []);
});

test('all providers failing yields one typed error with every failure reason', async () => {
  const { manager } = managerFor(
    [provider('you'), provider('firecrawl')],
    {
      you: { connectError: new SearchError('timeout', { code: 'MCP_TIMEOUT', retryable: true }) },
      firecrawl: { connectError: new SearchError('unreachable', { code: 'MCP_NETWORK', retryable: true }) },
    },
  );
  await assert.rejects(manager.search({ query: 'all fail' }), (error) => {
    assert.equal(error.code, 'SEARCH_ALL_PROVIDERS_FAILED');
    assert.match(error.message, /you: timeout/);
    assert.match(error.message, /firecrawl: tidak dapat dihubungi/);
    assert.equal(error.details.attempts.length, 2);
    return true;
  });
});

test('fallback disabled stops after the first provider failure', async () => {
  const { manager, calls } = managerFor(
    [provider('you'), provider('firecrawl')],
    { you: { connectError: new SearchError('timeout', { code: 'MCP_TIMEOUT', retryable: true }) } },
    { webSearchFallback: false },
  );
  await assert.rejects(manager.search({ query: 'no fallback' }), /timed out|timeout/i);
  assert.deepEqual(calls.connect, ['you']);
});

test('a provider disabled by the user is not contacted; /web enable restores it', async () => {
  const { manager, calls } = managerFor([provider('you', { enabled: false }), provider('firecrawl')], {});
  const first = await manager.search({ query: 'disabled' });
  assert.equal(first.provider, 'firecrawl');
  assert.deepEqual(calls.connect, ['firecrawl']);

  assert.equal(manager.setEnabled('you', true), true);
  const second = await manager.search({ query: 'enabled again' });
  assert.equal(second.provider, 'you');
  assert.deepEqual(calls.connect, ['firecrawl', 'you']);
});

test('duplicate result URLs are removed after canonicalization', async () => {
  const { manager } = managerFor([provider('you')], {
    you: {
      respond: () => ({
        structuredContent: {
          results: {
            web: [
              { title: 'One', url: 'https://a.example/x', description: 'first' },
              { title: 'Duplicate', url: 'https://a.example/x#section', description: 'second' },
              { title: 'Two', url: 'https://b.example/y', description: 'third' },
            ],
          },
        },
      }),
    },
  });
  const result = await manager.search({ query: 'dedupe' });
  assert.equal(result.result_count, 2);
  assert.deepEqual(result.results.map((item) => item.url), ['https://a.example/x', 'https://b.example/y']);
});

test('an invalid provider response falls back instead of reaching the model', async () => {
  const { manager } = managerFor(
    [provider('you'), provider('firecrawl')],
    {
      you: { respond: () => ({ content: [{ type: 'text', text: 'not json at all' }] }) },
    },
  );
  const result = await manager.search({ query: 'invalid payload' });
  assert.equal(result.provider, 'firecrawl');
});

test('in-band MCP tool errors (isError) are typed and trigger fallback', async () => {
  const { manager } = managerFor(
    [provider('you'), provider('firecrawl')],
    {
      you: { respond: () => ({ isError: true, content: [{ type: 'text', text: 'Error: Failed to perform search. Error code: 401' }] }) },
    },
  );
  const result = await manager.search({ query: 'in band error' });
  assert.equal(result.provider, 'firecrawl');
  assert.equal(manager.list().find((item) => item.id === 'you').lastReason, 'autentikasi gagal');
});

test('errors are logged without API keys or authorization headers', async () => {
  const logs = [];
  const logger = {
    debug: (...args) => logs.push(JSON.stringify(args)),
    warn: (...args) => logs.push(JSON.stringify(args)),
    info: (...args) => logs.push(JSON.stringify(args)),
  };
  const secret = 'sk-super-secret-value';
  const manager = new WebSearchManager({
    config: { webSearchResults: 5, webMcpTimeoutMs: 500, webMcpMaxRetries: 0 },
    logger,
    providers: [
      provider('you', { headers: { Authorization: `Bearer ${secret}` } }),
      provider('firecrawl'),
    ],
    connect: async (target) => {
      if (target.id === 'you') throw new SearchError('auth failed', { code: 'MCP_AUTH', status: 401 });
      return { client: {}, tools: [SEARCH_TOOL] };
    },
    callTool: async () => mcpText(rows(['https://ok.example/a'])),
    closeConnection: async () => {},
    sleep: async () => {},
  });
  const result = await manager.search({ query: 'secret check' });
  assert.equal(result.provider, 'firecrawl');
  assert.ok(!logs.join('\n').includes(secret));
  assert.ok(!JSON.stringify(manager.list()).includes(secret));
});

test('close() closes every cached MCP connection once', async () => {
  const { manager, calls } = managerFor([provider('you'), provider('firecrawl')], {});
  await manager.search({ query: 'first' });
  manager.setEnabled('you', false);
  await manager.search({ query: 'second' });
  await manager.close();
  assert.deepEqual(calls.close.sort(), ['firecrawl', 'you']);
  assert.deepEqual(manager.list().map((item) => item.connected), [false, false]);
});

test('transient call failures are retried with a bounded count', async () => {
  const { manager, calls } = managerFor(
    [provider('you')],
    {
      you: {
        errors: [new SearchError('temporary', { code: 'MCP_UPSTREAM', status: 503, retryable: true })],
      },
    },
    { webMcpMaxRetries: 1 },
  );
  const result = await manager.search({ query: 'retry once' });
  assert.equal(result.provider, 'you');
  assert.equal(calls.call.length, 2);
});

test('circuit breaker stops hammering a failing provider on later searches', async () => {
  const { manager, calls } = managerFor(
    [provider('you'), provider('firecrawl')],
    { you: { connectError: new SearchError('down', { code: 'MCP_NETWORK', retryable: true }) } },
  );
  await manager.search({ query: 'one' });
  await manager.search({ query: 'two' });
  assert.equal(manager.list().find((item) => item.id === 'you').circuitOpen, true);
  const before = calls.connect.filter((id) => id === 'you').length;
  await manager.search({ query: 'three' });
  assert.equal(calls.connect.filter((id) => id === 'you').length, before);
});

test('tool mapping uses names, descriptions and schemas, not provider-specific names', () => {
  const tools = [
    { name: 'you-search', description: 'web search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
    { name: 'you-contents', description: 'read page contents', inputSchema: { type: 'object', properties: { urls: { type: 'array' } } } },
  ];
  assert.equal(pickTool(tools, 'search').name, 'you-search');
  assert.equal(pickTool(tools, 'extract').name, 'you-contents');
  assert.equal(
    buildToolArgs(tools[1], 'extract', { url: 'https://example.com/a' }).urls[0],
    'https://example.com/a',
  );
  assert.throws(
    () => buildToolArgs({ name: 'x', inputSchema: { properties: {}, required: ['apiKey'] } }, 'search', { query: 'q' }),
    /unsupported argument/,
  );
});

test('normalization understands You, Firecrawl, Tavily, Markdown and rejects junk', () => {
  const you = normalizeSearchPayload({ results: { web: rows(['https://you.example/a']).results } });
  assert.equal(you.results[0].title, 'Title 1');

  const firecrawl = normalizeSearchPayload({ data: { web: rows(['https://fc.example/a']).results } });
  assert.equal(firecrawl.results[0].url, 'https://fc.example/a');

  const tavily = normalizeSearchPayload({ results: rows(['https://tv.example/a']).results });
  assert.equal(tavily.results[0].url, 'https://tv.example/a');

  const markdown = normalizeSearchPayload(
    '[Node docs](https://nodejs.org/api/)\nNode.js API reference\n[MDN](https://developer.mozilla.org/)',
  );
  assert.equal(markdown.results.length, 2);
  assert.equal(markdown.results[0].url, 'https://nodejs.org/api/');

  assert.throws(() => normalizeSearchPayload({ unexpected: true }), /unknown shape/);

  const tavilyExtract = normalizeExtractPayload({
    results: [{ url: 'https://tv.example/doc', raw_content: '# Tavily content' }],
  });
  assert.equal(tavilyExtract.text, '# Tavily content');
  assert.equal(tavilyExtract.url, 'https://tv.example/doc');

  assert.equal(canonicalUrl('ftp://example.com/a'), null);
  assert.equal(canonicalUrl('https://user:pass@example.com/a'), null);
});

test('real stdio MCP transport spawns, discovers, searches and closes', async () => {
  const fixture = fileURLToPath(new URL('../fixtures/mcp-stdio-server.js', import.meta.url));
  const manager = new WebSearchManager({
    config: { webSearchResults: 3, webMcpTimeoutMs: 8000, webMcpMaxRetries: 0 },
    providers: [
      provider('local', {
        label: 'Local fixture',
        transport: 'stdio',
        url: undefined,
        command: process.execPath,
        args: [fixture],
        env: {},
        capabilities: { search: true, extract: false },
      }),
    ],
  });
  const result = await manager.search({ query: 'stdio test' });
  assert.equal(result.provider, 'local');
  assert.equal(result.results[0].title, 'Fixture stdio test');
  assert.equal(result.results[0].url, 'https://fixture.example/page');
  await manager.close();
  assert.equal(manager.list()[0].connected, false);
});

test('web_search exposes provider results through the tool registry', async () => {
  const root = await makeTempDir('ryuu-search-');
  try {
    const config = testConfig(root, { webSearchApiKey: 'sk-test' });
    const { manager } = managerFor([provider('firecrawl')], {
      firecrawl: { respond: () => mcpText({ data: { web: rows(['https://docs.example/page']).results } }) },
    });
    const registry = new ToolRegistry();
    for (const tool of createWebTools({ config, manager })) registry.register(tool);
    assert.ok(registry.toOpenAITools().some((tool) => tool.function.name === 'web_search'));
    const { result } = await registry.execute('web_search', { query: 'docs' });
    assert.equal(result.provider, 'firecrawl');
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].url, 'https://docs.example/page');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
