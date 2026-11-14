import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { Writable } from 'node:stream';
import { createApp } from '../../src/cli/app.js';
import { parseCommandLine } from '../../src/cli/commands.js';
import { upsertServer } from '../../src/mcp/config.js';
import { createTestWorkspace, ScriptedProvider, response, testConfig, toolCall } from '../helpers.js';
import { mcpTempDir, stdioFixture } from '../unit/mcp-helpers.js';

function captureStream({ tty = false } = {}) {
  let data = '';
  const stream = new Writable({
    write(chunk, encoding, callback) {
      data += chunk.toString();
      callback();
    },
  });
  stream.isTTY = tty;
  stream.columns = 100;
  stream.rows = 40;
  stream.getColorDepth = () => 24;
  stream.getData = () => data;
  stream.reset = () => {
    data = '';
  };
  return stream;
}

function fakeInput() {
  const stream = new Writable({
    write(chunk, encoding, callback) {
      callback();
    },
  });
  stream.isTTY = false;
  return stream;
}

async function setup({ autostart = true, enabled = true, mcp = true } = {}) {
  const fixture = await createTestWorkspace();
  const config = testConfig(fixture.root);
  const dir = await mcpTempDir();
  await upsertServer(
    stdioFixture({
      enabled,
      env: { MCP_FIXTURE_SECRET: 'app-secret-token' },
    }),
    { dir },
  );
  const provider = new ScriptedProvider([
    response({ toolCalls: [toolCall('mcp_fixture_search_items', { query: 'from-app' })] }),
    response({ content: 'The MCP search returned one fixture item.' }),
  ]);
  const stdout = captureStream();
  const stderr = captureStream();
  const app = await createApp({
    config,
    cliOptions: { interactive: false, plain: true },
    stdout,
    stderr,
    input: fakeInput(),
    provider,
    mcp: mcp === false ? false : { dir, autostart },
    version: '0.1.0',
  });
  return {
    fixture,
    config,
    dir,
    provider,
    stdout,
    stderr,
    app,
    async cleanup() {
      await app.close().catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true });
      await fixture.cleanup();
    },
  };
}

test('createApp autostarts configured MCP servers and exposes /mcp in the dispatcher', async () => {
  const ctx = await setup();
  try {
    assert.ok(ctx.app.mcp, 'the app owns an MCP manager');
    assert.equal(ctx.app.mcp.stateOf('fixture').state, 'connected');
    assert.ok(ctx.app.registry.has('mcp_fixture_search_items'));
    assert.equal(ctx.app.commands.has('mcp'), true);

    const summary = await ctx.app.runTask('search the fixture with MCP');
    assert.equal(summary.status, 'completed');
    const output = ctx.stdout.getData();
    assert.match(output, /mcp:fixture:search_items/);
    assert.match(output, /The MCP search returned one fixture item/);

    // The tool result really reached the model as a tool message.
    const secondRequest = ctx.provider.calls[1];
    const toolMessage = secondRequest.messages.find((message) => message.role === 'tool');
    assert.match(toolMessage.content, /Fixture from-app/);

    ctx.stdout.reset();
    await ctx.app.commands.execute(parseCommandLine('/mcp status'));
    assert.match(ctx.stdout.getData(), /MCP Servers: 1 connected · 1 configured/);
    assert.match(ctx.stdout.getData(), /fixture/);
  } finally {
    await ctx.cleanup();
  }
});

test('app.close() stops the MCP child process', async () => {
  const ctx = await setup();
  let pid = null;
  try {
    const env = JSON.parse((await ctx.app.registry.execute('mcp_fixture_get_env', {})).result.text);
    pid = env.pid;
    assert.ok(pid > 0);
  } finally {
    await ctx.app.close();
  }
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    await fsp.rm(ctx.dir, { recursive: true, force: true });
    await ctx.fixture.cleanup();
  }
});

test('autostart:false keeps /mcp available without connecting anything', async () => {
  const ctx = await setup({ autostart: false });
  try {
    assert.equal(ctx.app.mcp.stateOf('fixture'), null);
    assert.equal(ctx.app.registry.has('mcp_fixture_search_items'), false);
    assert.equal(ctx.app.commands.has('mcp'), true);

    ctx.stdout.reset();
    await ctx.app.commands.execute(parseCommandLine('/mcp connect fixture'));
    assert.match(ctx.stdout.getData(), /fixture connected/);
    assert.ok(ctx.app.registry.has('mcp_fixture_search_items'));
  } finally {
    await ctx.cleanup();
  }
});

test('a disabled server is listed but never connected at startup', async () => {
  const ctx = await setup({ enabled: false });
  try {
    assert.equal(ctx.app.registry.has('mcp_fixture_search_items'), false);
    ctx.stdout.reset();
    await ctx.app.commands.execute(parseCommandLine('/mcp'));
    const output = ctx.stdout.getData();
    assert.match(output, /0 connected · 1 configured/);
    assert.match(output, /fixture/);
  } finally {
    await ctx.cleanup();
  }
});

test('mcp:false removes the integration but keeps /mcp as an honest no-op', async () => {
  const ctx = await setup({ mcp: false });
  try {
    assert.equal(ctx.app.mcp, null);
    assert.equal(ctx.app.registry.has('mcp_fixture_search_items'), false);
    assert.equal(ctx.app.commands.has('mcp'), true);
    ctx.stdout.reset();
    await ctx.app.commands.execute(parseCommandLine('/mcp'));
    assert.match(ctx.stdout.getData(), /MCP is not available in this session/);
  } finally {
    await ctx.cleanup();
  }
});
