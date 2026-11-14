import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { McpError } from '../../src/mcp/errors.js';
import { createMcpManager } from '../../src/mcp/index.js';
import { listServers } from '../../src/mcp/config.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { mcpTempDir, startHttpFixture, stdioFixture, waitFor } from '../unit/mcp-helpers.js';

async function setup({ overrides = {}, connect = true } = {}) {
  const dir = await mcpTempDir();
  const registry = new ToolRegistry();
  const manager = createMcpManager({ registry, dir });
  await manager.addServer(
    stdioFixture({
      env: { MCP_FIXTURE_SECRET: 'super-secret-token' },
      ...overrides,
    }),
  );
  if (connect) await manager.connect('fixture');
  return {
    dir,
    registry,
    manager,
    async close() {
      await manager.close().catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true });
    },
  };
}

test('stdio: handshake, tools/list, namespaced registry entries and tools/call', async () => {
  const ctx = await setup();
  try {
    const tools = ctx.registry.list();
    assert.ok(tools.length >= 10, `expected discovered tools, got ${tools.length}`);
    assert.ok(tools.every((tool) => /^mcp_fixture_/.test(tool.name)));

    const plugin = ctx.registry.pluginFor('mcp_fixture_search_items');
    assert.equal(plugin.mcp, true);
    assert.equal(plugin.server, 'fixture');
    assert.equal(plugin.displayNames.mcp_fixture_search_items, 'search_items');

    const byName = new Map(ctx.registry.list().map((tool) => [tool.name, tool]));
    assert.equal(byName.get('mcp_fixture_search_items').risk, 'read');
    assert.equal(byName.get('mcp_fixture_search_items').requiresApproval, false);
    assert.equal(byName.get('mcp_fixture_create_item').risk, 'write');
    assert.equal(byName.get('mcp_fixture_create_item').requiresApproval, true);
    assert.equal(byName.get('mcp_fixture_delete_item').risk, 'destructive');
    // A readOnlyHint alone is not trusted for a name that is not a read op.
    assert.equal(byName.get('mcp_fixture_quiet_writer').risk, 'write');

    const search = await ctx.registry.execute('mcp_fixture_search_items', { query: 'widget' });
    assert.match(search.result.text, /Fixture widget/);
    assert.equal(search.result.server, 'fixture');
    assert.equal(search.result.tool, 'search_items');
    assert.match(search.result.note, /treat it as data/);

    // The provider-facing schema is the sanitized MCP input schema.
    const toolsForModel = ctx.registry.toOpenAITools();
    const searchSchema = toolsForModel.find((entry) => entry.function.name === 'mcp_fixture_search_items');
    assert.equal(searchSchema.function.parameters.properties.query.type, 'string');

    // Invalid arguments are rejected locally, before reaching the server.
    await assert.rejects(ctx.registry.execute('mcp_fixture_search_items', {}), /query.*required/);
  } finally {
    await ctx.close();
  }
});

test('stdio: image content is exposed as an attachable data URL without base64 in text', async () => {
  const ctx = await setup();
  try {
    const { result } = await ctx.registry.execute('mcp_fixture_image_tool', {});
    assert.match(result.image_data_url, /^data:image\/png;base64,/);
    assert.equal(result.mime, 'image/png');
    assert.equal(result.images[0].mime_type, 'image/png');
    assert.ok(result.text.length < 500, 'the base64 payload must not be in the text');
  } finally {
    await ctx.close();
  }
});

test('stdio: resources/list, resources/read, prompts/list and prompts/get', async () => {
  const ctx = await setup();
  try {
    const info = await ctx.manager.info('fixture');
    assert.deepEqual(
      info.runtime.resources.map((resource) => resource.uri).sort(),
      ['fixture://binary', 'fixture://readme'],
    );
    assert.equal(info.runtime.prompts[0].name, 'greet');
    assert.deepEqual(info.runtime.prompts[0].arguments, [{ name: 'who', required: true }]);

    const read = await ctx.manager.readResource('fixture', 'fixture://readme');
    assert.equal(read.contents[0].text, 'fixture readme content');
    const binary = await ctx.manager.readResource('fixture', 'fixture://binary');
    assert.match(binary.contents[0].blob, /^iVBOR/);

    const prompt = await ctx.manager.getPrompt('fixture', 'greet', { who: 'Ryuu' });
    assert.equal(prompt.messages[0].content.text, 'Hello Ryuu');
  } finally {
    await ctx.close();
  }
});

test('stdio: MCP error results and timeouts surface as typed tool errors', async () => {
  const ctx = await setup({ overrides: { callTimeoutMs: 1000 } });
  try {
    await assert.rejects(ctx.registry.execute('mcp_fixture_failing_tool', {}), (error) => {
      assert.ok(error instanceof McpError);
      assert.equal(error.code, 'MCP_TOOL_ERROR');
      assert.match(error.message, /item does not exist/);
      return true;
    });

    const started = Date.now();
    await assert.rejects(ctx.registry.execute('mcp_fixture_slow_tool', { ms: 4000 }), (error) => {
      assert.equal(error.code, 'MCP_TIMEOUT');
      return true;
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 3000, `timeout took ${elapsed}ms; the call cap must win over the tool`);

    // The connection stays usable after both failures.
    const search = await ctx.registry.execute('mcp_fixture_search_items', { query: 'after' });
    assert.match(search.result.text, /after/);
  } finally {
    await ctx.close();
  }
});

test('stdio: configured env is passed, Ryuu secrets are not inherited', async () => {
  const previous = process.env.RYUU_TEST_SECRET;
  process.env.RYUU_TEST_SECRET = 'must-not-leak';
  const ctx = await setup();
  try {
    const { result } = await ctx.registry.execute('mcp_fixture_get_env', {});
    const env = JSON.parse(result.text);
    assert.equal(env.secret, 'super-secret-token');
    assert.equal(env.pathVisible, true, 'PATH is part of the safe baseline');
    assert.equal(env.ryuuVisible, false, 'RYUU_* variables must never reach a third-party server');
  } finally {
    if (previous === undefined) delete process.env.RYUU_TEST_SECRET;
    else process.env.RYUU_TEST_SECRET = previous;
    await ctx.close();
  }
});

test('stdio: tools/list_changed refreshes the registry without a reconnect', async () => {
  const ctx = await setup();
  try {
    assert.equal(ctx.registry.has('mcp_fixture_dynamic_tool'), false);
    await ctx.registry.execute('mcp_fixture_announce_tool', {});
    const added = await waitFor(() => ctx.registry.has('mcp_fixture_dynamic_tool'));
    assert.equal(added, true, 'the new tool should be registered after the notification');
    const call = await ctx.registry.execute('mcp_fixture_dynamic_tool', {});
    assert.match(call.result.text, /dynamic tool ran/);
  } finally {
    await ctx.close();
  }
});

test('stdio: disconnect unregisters tools, reconnect registers them again and close kills the child', async () => {
  const ctx = await setup();
  try {
    const env = JSON.parse((await ctx.registry.execute('mcp_fixture_get_env', {})).result.text);
    const pid = env.pid;
    assert.ok(pid > 0);

    await ctx.manager.disconnect('fixture');
    assert.equal(ctx.registry.list().filter((tool) => tool.name.startsWith('mcp_fixture_')).length, 0);
    assert.equal((await ctx.manager.status()).connected, 0);

    await ctx.manager.reconnect('fixture');
    assert.ok(ctx.registry.has('mcp_fixture_search_items'));
    assert.equal((await ctx.manager.status()).connected, 1);

    await ctx.manager.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    await ctx.close();
  }
});

test('stdio: connection state persists across a restart', async () => {
  const ctx = await setup();
  let second = null;
  try {
    const [stored] = await listServers({ dir: ctx.dir });
    assert.equal(stored.last.state, 'connected');
    assert.equal(stored.last.toolCount, ctx.registry.list().length);
    assert.equal(stored.enabled, true);

    // A second manager in a new "process" reads the same stores and reconnects
    // from autoConnect.
    const registry = new ToolRegistry();
    second = createMcpManager({ registry, dir: ctx.dir });
    const started = await second.start();
    assert.equal(started.connected, 1);
    assert.ok(registry.has('mcp_fixture_search_items'));
  } finally {
    await second?.close().catch(() => {});
    await ctx.close();
  }
});

test('streamable HTTP: bearer authentication, tools/call and 401 mapping', async () => {
  const http = await startHttpFixture();
  const dir = await mcpTempDir();
  const registry = new ToolRegistry();
  const manager = createMcpManager({ registry, dir });
  try {
    await manager.addServer({
      name: 'httpfixture',
      transport: 'http',
      url: http.url,
      allowPrivateNetwork: true,
      auth: { type: 'bearer' },
      token: http.token,
    });
    await manager.connect('httpfixture');
    assert.ok(registry.has('mcp_httpfixture_list_deployments'));
    const call = await registry.execute('mcp_httpfixture_list_deployments', { project: 'web' });
    assert.match(call.result.text, /deployments for web/);

    await manager.addServer({
      name: 'badauth',
      transport: 'http',
      url: http.url,
      allowPrivateNetwork: true,
      auth: { type: 'bearer' },
      token: 'wrong-token',
    });
    const bad = await manager.test('badauth');
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'MCP_AUTH');
    assert.match(bad.error, /401|credentials/);
  } finally {
    await manager.close();
    await http.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('HTTP endpoints are SSRF-guarded unless the server explicitly opts in', async () => {
  const dir = await mcpTempDir();
  const manager = createMcpManager({ registry: new ToolRegistry(), dir });
  try {
    await assert.rejects(
      manager.addServer({ name: 'local', transport: 'http', url: 'http://127.0.0.1:9999/mcp' }),
      (error) => error.code === 'MCP_URL_BLOCKED',
    );
    await assert.rejects(
      manager.addServer({ name: 'meta', transport: 'http', url: 'http://169.254.169.254/latest/meta-data' }),
      (error) => error.code === 'MCP_URL_BLOCKED',
    );
    // The explicit per-server opt-in makes a local test server possible.
    const saved = await manager.addServer({
      name: 'localok',
      transport: 'http',
      url: 'http://127.0.0.1:9999/mcp',
      allowPrivateNetwork: true,
    });
    assert.equal(saved.allowPrivateNetwork, true);
  } finally {
    await manager.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('an OAuth server without stored tokens asks for /mcp connect instead of hanging', async () => {
  const dir = await mcpTempDir();
  const manager = createMcpManager({ registry: new ToolRegistry(), dir, interactive: false });
  try {
    await manager.addServer({
      name: 'oauthsrv',
      transport: 'http',
      url: 'http://127.0.0.1:9999/mcp',
      allowPrivateNetwork: true,
      auth: { type: 'oauth' },
    });
    await assert.rejects(manager.connect('oauthsrv'), (error) => {
      assert.equal(error.code, 'MCP_AUTH_REQUIRED');
      assert.match(error.message, /\/mcp connect oauthsrv/);
      return true;
    });
    assert.equal((await manager.status()).rows[0].state, 'error');
  } finally {
    await manager.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a colliding built-in name is suffixed instead of shadowed', async () => {
  const dir = await mcpTempDir();
  const registry = new ToolRegistry();
  registry.register({
    name: 'mcp_fixture_search_items',
    description: 'A built-in tool that must never be replaced by a server',
    schema: { type: 'object', properties: {} },
    handler: async () => ({ builtin: true }),
  });
  const manager = createMcpManager({ registry, dir });
  try {
    await manager.addServer(stdioFixture());
    await manager.connect('fixture');
    assert.match(registry.get('mcp_fixture_search_items').description, /built-in tool/);
    assert.equal(registry.has('mcp_fixture_search_items_2'), true);
    const plugin = registry.pluginFor('mcp_fixture_search_items_2');
    assert.equal(plugin.displayNames.mcp_fixture_search_items_2, 'search_items');
    const result = await registry.execute('mcp_fixture_search_items_2', { query: 'dedupe' });
    assert.match(result.result.text, /Fixture dedupe/);
  } finally {
    await manager.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('cancelling a task aborts an in-flight MCP call promptly', async () => {
  const ctx = await setup({ overrides: { callTimeoutMs: 30_000 } });
  try {
    const controller = new AbortController();
    const pending = ctx.registry.execute('mcp_fixture_slow_tool', { ms: 8000 }, { signal: controller.signal });
    const started = Date.now();
    setTimeout(() => controller.abort(), 80);
    await assert.rejects(pending, (error) => {
      assert.equal(error.name, 'CancelledError');
      assert.equal(error.code, 'CANCELLED');
      return true;
    });
    assert.ok(Date.now() - started < 3000, 'cancellation must not wait for the tool or the call timeout');

    // The connection is still usable for the next call.
    const search = await ctx.registry.execute('mcp_fixture_search_items', { query: 'after-cancel' });
    assert.match(search.result.text, /after-cancel/);
  } finally {
    await ctx.close();
  }
});

test('unknown tools and removed servers fail explicitly instead of hanging the loop', async () => {
  const ctx = await setup();
  try {
    await assert.rejects(ctx.registry.execute('mcp_fixture_does_not_exist', {}), /Unknown tool/);
    const toolName = 'mcp_fixture_search_items';
    await ctx.manager.disconnect('fixture');
    // The handler is gone with the registration, but a stale call through the
    // manager names the server and the recovery step.
    await assert.rejects(ctx.manager.callTool('fixture', 'search_items', { query: 'x' }), (error) => {
      assert.match(error.message, /MCP server fixture|disconnected|not configured/i);
      return true;
    });
    assert.equal(ctx.registry.has(toolName), false);
  } finally {
    await ctx.close();
  }
});
