import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { Agent } from '../../src/agent/agent.js';
import { createUrlTools } from '../../src/tools/url.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { buildToolRegistry } from '../../src/tools/index.js';
import { Workspace } from '../../src/services/workspace.js';
import { RecordingRenderer, ScriptedProvider, makeTempDir, response, testConfig, toolCall } from '../helpers.js';

function htmlResponse(body, { status = 200, contentType = 'text/html; charset=utf-8', headers = {} } = {}) {
  return new Response(body, { status, headers: { 'content-type': contentType, ...headers } });
}

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  fn.calls = calls;
  return fn;
}

async function execute(tools, args, ctx = {}) {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry.execute('read_url', args, ctx);
}

const PAGE = `<!doctype html>
<html><head>
  <title> Node &amp; Fetch </title>
  <meta name="description" content="A guide to fetch &amp; streams.">
  <meta property="og:description" content="lower priority">
  <script>window.secret = "do not leak"</script>
  <style>.hidden { color: red; }</style>
</head><body>
  <nav><a href="/">Home</a></nav>
  <h1>Reading pages</h1>
  <p>First&nbsp;paragraph with &lt;tags&gt; and &#39;quotes&#39;.</p>
  <ul><li>One</li><li>Two</li></ul>
  <!-- an internal comment -->
  <footer>Footer junk</footer>
</body></html>`;

test('read_url extracts title, description and readable text from HTML', async () => {
  const fetch = fakeFetch(() => htmlResponse(PAGE));
  const tools = createUrlTools({ fetch });
  const { result } = await execute(tools, { url: 'https://example.com/docs' });

  assert.equal(result.url, 'https://example.com/docs');
  assert.equal(result.final_url, 'https://example.com/docs');
  assert.equal(result.status, 200);
  assert.equal(result.title, 'Node & Fetch');
  assert.equal(result.description, 'A guide to fetch & streams.');
  assert.match(result.text, /Reading pages/);
  assert.match(result.text, /First paragraph with <tags> and 'quotes'\./);
  assert.match(result.text, /- One/);
  assert.match(result.text, /- Two/);
  assert.doesNotMatch(result.text, /do not leak|Footer junk|Home|hidden/);
  assert.equal(result.truncated, false);
  assert.equal(result.bytes_truncated, false);
  assert.equal(result.redirects, 0);
  assert.equal(result.content_type, 'text/html; charset=utf-8');
  assert.match(result.fetched_at, /^\d{4}-\d{2}-\d{2}T/);

  const [{ url, init }] = fetch.calls;
  assert.equal(url, 'https://example.com/docs');
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'manual');
  assert.match(init.headers['user-agent'], /ryuu-agent-cli/);
  assert.match(init.headers.accept, /text\/html/);
});

test('read_url follows validated redirects and reports the final URL', async () => {
  const fetch = fakeFetch((url) => {
    if (url === 'https://example.com/start') {
      return new Response('', { status: 302, headers: { location: '/final' } });
    }
    return htmlResponse('<html><head><title>Final</title></head><body>arrived</body></html>');
  });
  const { result } = await execute(createUrlTools({ fetch }), { url: 'https://example.com/start' });
  assert.equal(result.url, 'https://example.com/start');
  assert.equal(result.final_url, 'https://example.com/final');
  assert.equal(result.redirects, 1);
  assert.match(result.text, /arrived/);

  await assert.rejects(
    execute(createUrlTools({ fetch: fakeFetch(() => new Response('', { status: 302, headers: { location: 'ftp://example.com/x' } })) }), {
      url: 'https://example.com/start',
    }),
    (error) => error.code === 'READ_URL_REDIRECT',
  );

  await assert.rejects(
    execute(createUrlTools({ fetch: fakeFetch(() => new Response('', { status: 302, headers: { location: 'http://example.com/x' } })) }), {
      url: 'https://example.com/start',
    }),
    (error) => error.code === 'READ_URL_REDIRECT' && /insecure http/.test(error.message),
  );

  await assert.rejects(
    execute(createUrlTools({ fetch: fakeFetch(() => new Response('', { status: 302 })) }), {
      url: 'https://example.com/start',
    }),
    (error) => error.code === 'READ_URL_REDIRECT' && /Location/.test(error.message),
  );

  const loop = fakeFetch((url) => new Response('', { status: 302, headers: { location: url } }));
  await assert.rejects(
    execute(createUrlTools({ fetch: loop }), { url: 'https://example.com/start' }),
    (error) => error.code === 'READ_URL_REDIRECT' && /Too many redirects/.test(error.message),
  );
});

test('read_url rejects non-http URLs, credentials and binary content', async () => {
  const fetch = fakeFetch(() => htmlResponse('ok'));
  await assert.rejects(
    execute(createUrlTools({ fetch }), { url: 'file:///etc/passwd' }),
    (error) => error.code === 'READ_URL_INVALID',
  );
  await assert.rejects(
    execute(createUrlTools({ fetch }), { url: 'https://user:pass@example.com/private' }),
    (error) => error.code === 'READ_URL_INVALID',
  );
  await assert.rejects(
    execute(createUrlTools({ fetch }), { url: 'not a url' }),
    (error) => error.code === 'READ_URL_INVALID',
  );
  assert.equal(fetch.calls.length, 0);

  await assert.rejects(
    execute(createUrlTools({ fetch: fakeFetch(() => htmlResponse('x', { contentType: 'image/png' })) }), {
      url: 'https://example.com/logo.png',
    }),
    (error) => error.code === 'READ_URL_UNSUPPORTED' && /image\/png/.test(error.message),
  );
});

test('read_url returns plain text unchanged and maps HTTP failures', async () => {
  const plain = await execute(
    createUrlTools({ fetch: fakeFetch(() => htmlResponse('a <b>literal</b> tag', { contentType: 'text/plain' })) }),
    { url: 'https://example.com/notes.txt' },
  );
  assert.equal(plain.result.title, null);
  assert.match(plain.result.text, /a <b>literal<\/b> tag/);

  const cases = [
    [401, 'READ_URL_AUTH'],
    [403, 'READ_URL_AUTH'],
    [404, 'READ_URL_NOT_FOUND'],
    [410, 'READ_URL_NOT_FOUND'],
    [429, 'READ_URL_RATE_LIMIT'],
    [503, 'READ_URL_UPSTREAM'],
    [418, 'READ_URL_FAILED'],
  ];
  for (const [status, code] of cases) {
    await assert.rejects(
      execute(createUrlTools({ fetch: fakeFetch(() => htmlResponse('nope', { status })) }), {
        url: `https://example.com/${status}`,
      }),
      (error) => error.code === code && error.status === status,
      `expected ${status} -> ${code}`,
    );
  }
});

test('read_url reports network failures, timeouts and cancellation', async () => {
  const network = fakeFetch(() => {
    throw Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND example.test') });
  });
  await assert.rejects(
    execute(createUrlTools({ fetch: network }), { url: 'https://example.test/page' }),
    (error) => error.code === 'READ_URL_NETWORK' && /ENOTFOUND/.test(error.message),
  );

  const stalling = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  await assert.rejects(
    execute(createUrlTools({ fetch: stalling, timeoutMs: 50 }), { url: 'https://example.test/slow' }),
    (error) => error.code === 'READ_URL_TIMEOUT',
  );

  const controller = new AbortController();
  const external = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    setTimeout(() => controller.abort(), 20);
  });
  await assert.rejects(
    execute(createUrlTools({ fetch: external, timeoutMs: 5000 }), { url: 'https://example.test/cancel' }, { signal: controller.signal }),
    (error) => error.code === 'CANCELLED',
  );
});

test('read_url bounds extracted text and the response body', async () => {
  const long = await execute(
    createUrlTools({ fetch: fakeFetch(() => htmlResponse('b'.repeat(3000), { contentType: 'text/plain' })) }),
    { url: 'https://example.com/long', max_chars: 1000 },
  );
  assert.equal(long.result.text.length, 1000);
  assert.equal(long.result.truncated, true);

  const huge = 'a'.repeat(2 * 1024 * 1024 + 10);
  const capped = await execute(
    createUrlTools({ fetch: fakeFetch(() => htmlResponse(huge, { contentType: 'text/plain' })) }),
    { url: 'https://example.com/huge' },
  );
  assert.equal(capped.result.bytes_truncated, true);
  assert.equal(capped.result.bytes, 2 * 1024 * 1024);
  assert.match(capped.result.note, /exceeded/);
});

test('read_url is registered as a read-only tool without a search key', async () => {
  const root = await makeTempDir('ryuu-url-registry-');
  try {
    const workspace = new Workspace(root);
    const registry = buildToolRegistry({ workspace, config: testConfig(root) });
    assert.equal(registry.has('web_search'), false);
    const tool = registry.get('read_url');
    assert.equal(tool.risk, 'read');
    assert.equal(tool.requiresApproval, false);
    assert.deepEqual(tool.schema.required, ['url']);
    assert.ok(registry.toOpenAITools().some((entry) => entry.function.name === 'read_url'));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('agent calls read_url end to end and records the source in the worklog', async (t) => {
  const root = await makeTempDir('ryuu-url-agent-');
  try {
    const workspace = new Workspace(root);
    const config = testConfig(root);
    const registry = buildToolRegistry({ workspace, config });
    const provider = new ScriptedProvider([
      response({ toolCalls: [toolCall('read_url', { url: 'https://example.com/guide' })] }),
      response({ content: 'The guide says the flag defaults to off (https://example.com/guide).' }),
    ]);
    const renderer = new RecordingRenderer();
    const agent = new Agent({ provider, registry, workspace, config, renderer });
    const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
      htmlResponse('<html><head><title>Guide</title></head><body><p>The flag defaults to off.</p></body></html>'));

    const summary = await agent.run('read the guide');

    assert.equal(summary.status, 'completed');
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.ok(provider.calls[0].tools.some((entry) => entry.function.name === 'read_url'));
    const toolMessage = provider.calls[1].messages.find((message) => message.role === 'tool');
    const payload = JSON.parse(toolMessage.content);
    assert.equal(payload.ok, true);
    assert.equal(payload.result.title, 'Guide');
    assert.match(payload.result.text, /defaults to off/);
    assert.match(agent.getWorklog().brief(), /read_url https:\/\/example\.com\/guide -> HTTP 200/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
