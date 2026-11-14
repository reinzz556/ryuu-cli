import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { McpManager } from '../../src/mcp/index.js';
import { credentialsFile, readSecrets } from '../../src/mcp/config.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { buildToolRegistry } from '../../src/tools/index.js';
import { ProcessManager } from '../../src/services/processes.js';
import { SessionStore } from '../../src/services/sessions.js';
import { UndoManager } from '../../src/services/undo.js';
import { createCommands, parseCommandLine } from '../../src/cli/commands.js';
import { createTestWorkspace, testConfig } from '../helpers.js';
import { STDIO_FIXTURE, commandRenderer, mcpTempDir, stdioFixture } from '../unit/mcp-helpers.js';

async function setup({ interactive = false, ask = null, confirm = async () => true, withServer = true } = {}) {
  const fixture = await createTestWorkspace();
  const config = testConfig(fixture.root);
  const registry = buildToolRegistry({ workspace: fixture.workspace, config });
  const processes = new ProcessManager({ workspace: fixture.workspace, defaultTimeoutMs: 5000 });
  const dir = await mcpTempDir();
  const manager = new McpManager({ registry, dir, interactive });
  if (withServer) {
    await manager.addServer(
      stdioFixture({
        env: { MCP_FIXTURE_SECRET: 'super-secret-token' },
      }),
    );
    await manager.connect('fixture');
  }
  const renderer = commandRenderer({ styled: true });
  const state = {
    config,
    workspace: fixture.workspace,
    registry,
    processes,
    sessionStore: new SessionStore({ dir: config.historyDir }),
    undo: new UndoManager({ workspace: fixture.workspace, dir: config.undoDir }),
    renderer,
    provider: { config: {} },
    interactive,
    plugins: [],
    mcp: manager,
    askLocal: ask,
    confirmLocal: confirm,
    getAgent: () => null,
    getLastSummary: () => null,
    cancelActiveTask: () => false,
  };
  const commands = createCommands(state);
  const run = (line) => commands.execute(parseCommandLine(line));
  return {
    fixture,
    config,
    registry,
    manager,
    dir,
    renderer,
    commands,
    run,
    async cleanup() {
      await manager.close().catch(() => {});
      await processes.stopAll().catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true });
      await fixture.cleanup();
    },
  };
}

test('/help discovers /mcp and explains every subcommand', async () => {
  const ctx = await setup();
  try {
    await ctx.run('/help');
    assert.match(ctx.renderer.text(), /\/mcp\s+Manage MCP servers/);
    await ctx.run('/help mcp');
    const help = ctx.renderer.text();
    assert.match(help, /\/mcp\s+\[list\|status\|add\|remove/);
    assert.match(help, /\/mcp add\s+interactive wizard/);
    assert.match(help, /approval gate/);
  } finally {
    await ctx.cleanup();
  }
});

test('/mcp and /mcp status render the connection table through the renderer', async () => {
  const ctx = await setup();
  try {
    await ctx.run('/mcp');
    assert.equal(ctx.renderer.statusBlocks.length, 1);
    assert.equal(ctx.renderer.statusBlocks[0].summary, '1 connected · 1 configured');
    assert.equal(ctx.renderer.statusBlocks[0].rows[0].name, 'fixture');
    assert.equal(ctx.renderer.statusBlocks[0].rows[0].state, 'connected');
    assert.match(String(ctx.renderer.statusBlocks[0].rows[0].detail), /tool\(s\)/);

    await ctx.run('/mcp status');
    assert.equal(ctx.renderer.statusBlocks.length, 2);
    assert.match(ctx.renderer.text(), /\/mcp info <name>/);
  } finally {
    await ctx.cleanup();
  }
});

test('/mcp info, tools, resources, prompts and logs never expose secrets', async () => {
  const ctx = await setup();
  try {
    await ctx.run('/mcp info fixture');
    const info = ctx.renderer.text();
    assert.match(info, /MCP server: fixture/);
    assert.match(info, /state\s+connected/);
    assert.match(info, /env keys\s+MCP_FIXTURE_SECRET \(values redacted\)/);
    assert.equal(info.includes('super-secret-token'), false);
    assert.match(info, /credentials/);

    ctx.renderer.linesList.length = 0;
    await ctx.run('/mcp tools fixture');
    const tools = ctx.renderer.text();
    assert.match(tools, /mcp:fixture:search_items/);
    assert.match(tools, /mcp:fixture:delete_item\s+destructive\s+approval/);
    assert.match(tools, /mcp:fixture:create_item\s+write\s+approval/);

    ctx.renderer.linesList.length = 0;
    await ctx.run('/mcp resources fixture');
    assert.match(ctx.renderer.text(), /fixture:\/\/readme/);
    ctx.renderer.linesList.length = 0;
    await ctx.run('/mcp resources fixture fixture://readme');
    assert.match(ctx.renderer.text(), /fixture readme content/);
    ctx.renderer.linesList.length = 0;
    await ctx.run('/mcp resources fixture fixture://binary');
    assert.match(ctx.renderer.text(), /binary/);
    assert.match(ctx.renderer.text(), /not printed/);

    ctx.renderer.linesList.length = 0;
    await ctx.run('/mcp prompts fixture');
    assert.match(ctx.renderer.text(), /greet/);
    ctx.renderer.linesList.length = 0;
    await ctx.run('/mcp prompts fixture greet who=Ada');
    assert.match(ctx.renderer.text(), /Hello Ada/);
    assert.match(ctx.renderer.text(), /Nothing was sent to the agent/);

    ctx.renderer.linesList.length = 0;
    await ctx.run('/mcp logs fixture');
    const logs = ctx.renderer.text();
    assert.match(logs, /INFO connected/);
    assert.equal(logs.includes('super-secret-token'), false);

    ctx.renderer.linesList.length = 0;
    await ctx.run('/mcp config');
    const config = ctx.renderer.text();
    assert.match(config, /MCP CONFIGURATION/);
    assert.match(config, /servers\.json 0600/);
    assert.match(config, /credentials/);
  } finally {
    await ctx.cleanup();
  }
});

test('/mcp test, refresh, disconnect, connect, disable and enable drive the same manager', async () => {
  const ctx = await setup();
  try {
    await ctx.run('/mcp test fixture');
    assert.match(ctx.renderer.text(), /fixture ✓ connected/);
    assert.match(ctx.renderer.text(), /tools: 11/);

    ctx.renderer.linesList.length = 0;
    await ctx.run('/mcp refresh fixture');
    assert.match(ctx.renderer.text(), /fixture refreshed · 11 tool\(s\)/);

    ctx.renderer.linesList.length = 0;
    await ctx.run('/mcp disconnect fixture');
    assert.match(ctx.renderer.text(), /disconnected/);
    assert.equal(ctx.registry.has('mcp_fixture_search_items'), false);

    ctx.renderer.linesList.length = 0;
    await ctx.run('/mcp connect fixture');
    assert.match(ctx.renderer.text(), /fixture connected · 11 tool\(s\)/);
    assert.equal(ctx.registry.has('mcp_fixture_search_items'), true);

    ctx.renderer.linesList.length = 0;
    await ctx.run('/mcp disable fixture');
    assert.match(ctx.renderer.text(), /disabled/);
    assert.equal(ctx.registry.has('mcp_fixture_search_items'), false);
    assert.equal((await ctx.manager.status()).rows[0].state, 'disabled');

    ctx.renderer.linesList.length = 0;
    await ctx.run('/mcp enable fixture');
    assert.match(ctx.renderer.text(), /enabled and connected/);
    assert.equal(ctx.registry.has('mcp_fixture_search_items'), true);
  } finally {
    await ctx.cleanup();
  }
});

test('/mcp add without a terminal explains the file-based path; unknown input is rejected', async () => {
  const ctx = await setup({ withServer: false });
  try {
    await ctx.run('/mcp add newserver');
    assert.match(ctx.renderer.text(), /needs an interactive terminal/);
    assert.match(ctx.renderer.text(), /servers\.json/);

    ctx.renderer.linesList.length = 0;
    await ctx.run('/mcp remove');
    assert.match(ctx.renderer.text(), /Usage: \/mcp remove <name>/);

    ctx.renderer.linesList.length = 0;
    await ctx.run('/mcp connect no-such-server');
    assert.match(ctx.renderer.text(), /Unknown MCP server: no-such-server/);

    ctx.renderer.linesList.length = 0;
    await ctx.run('/mcp frobnicate');
    assert.match(ctx.renderer.text(), /Unknown \/mcp subcommand: frobnicate/);
  } finally {
    await ctx.cleanup();
  }
});

test('the /mcp add wizard saves a server, stores its secret privately and connects it', async () => {
  const answers = [
    'wizard', // name
    'stdio', // transport
    process.execPath, // command
    STDIO_FIXTURE, // arguments
    '', // cwd
    'MCP_FIXTURE_SECRET=wizard-secret', // env
    '', // env end
  ];
  let asked = 0;
  const ask = async () => answers[Math.min(asked++, answers.length - 1)];
  const confirmations = [];
  const confirm = async (question) => {
    confirmations.push(question);
    return true;
  };
  const ctx = await setup({ interactive: true, ask, confirm, withServer: false });
  try {
    await ctx.run('/mcp add');
    const output = ctx.renderer.text();
    assert.match(output, /Saved wizard/);
    assert.match(output, /Connection OK/);
    assert.match(output, /Token|Registered 11 tool/);
    assert.ok(confirmations.some((question) => /Save this MCP server/.test(question)));
    assert.equal(output.includes('wizard-secret'), false, 'env values are never echoed');

    assert.equal(ctx.registry.has('mcp_wizard_search_items'), true);
    const secrets = await readSecrets('wizard', { dir: ctx.dir });
    assert.equal(secrets.env.MCP_FIXTURE_SECRET, 'wizard-secret');
    const mode = (await fsp.stat(credentialsFile('wizard', ctx.dir))).mode & 0o777;
    assert.equal(mode, 0o600);

    ctx.renderer.linesList.length = 0;
    await ctx.run('/mcp remove wizard');
    assert.match(ctx.renderer.text(), /Removed wizard/);
    assert.equal(ctx.registry.has('mcp_wizard_search_items'), false);
    assert.deepEqual(await readSecrets('wizard', { dir: ctx.dir }), {});
  } finally {
    await ctx.cleanup();
  }
});

test('/mcp token reads a private file and updates the stored bearer token', async () => {
  const ctx = await setup();
  const tokenFile = path.join(ctx.dir, 'token.txt');
  await fsp.writeFile(tokenFile, 'fresh-token-value\n', { mode: 0o600 });
  try {
    await ctx.run(`/mcp token fixture ${tokenFile}`);
    assert.match(ctx.renderer.text(), /Token stored owner-only for fixture/);
    assert.equal((await readSecrets('fixture', { dir: ctx.dir })).token, 'fresh-token-value');
    assert.equal(ctx.renderer.text().includes('fresh-token-value'), false);
  } finally {
    await ctx.cleanup();
  }
});

test('a command failure inside /mcp is reported, not thrown at the REPL', async () => {
  const ctx = await setup();
  try {
    await ctx.run('/mcp resources fixture fixture://unknown');
    assert.match(ctx.renderer.text(), /Could not read fixture:\/\/unknown/);

    ctx.renderer.linesList.length = 0;
    await ctx.run('/mcp prompts fixture nope');
    assert.match(ctx.renderer.text(), /Could not render prompt nope/);
  } finally {
    await ctx.cleanup();
  }
});
