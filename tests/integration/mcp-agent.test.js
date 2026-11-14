import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Agent } from '../../src/agent/agent.js';
import { ApprovalManager } from '../../src/agent/approvals.js';
import { McpManager } from '../../src/mcp/index.js';
import { buildToolRegistry } from '../../src/tools/index.js';
import { createTestWorkspace, RecordingRenderer, ScriptedProvider, response, testConfig, toolCall } from '../helpers.js';
import { mcpTempDir, stdioFixture } from '../unit/mcp-helpers.js';

async function setup({ responses, confirm = async () => true, policy = 'ask' }) {
  const fixture = await createTestWorkspace();
  const config = testConfig(fixture.root, { approvalPolicy: policy, maxSteps: 4 });
  const registry = buildToolRegistry({ workspace: fixture.workspace, config });
  const dir = await mcpTempDir();
  const manager = new McpManager({ registry, dir });
  await manager.addServer(stdioFixture());
  await manager.connect('fixture');

  const confirmations = [];
  const approvals = new ApprovalManager({
    policy,
    interactive: true,
    confirm: async (request) => {
      confirmations.push(request);
      return confirm(request);
    },
  });
  const provider = new ScriptedProvider(responses);
  const renderer = new RecordingRenderer();
  const agent = new Agent({ provider, registry, workspace: fixture.workspace, config, renderer, approvals });

  return {
    fixture,
    config,
    registry,
    dir,
    manager,
    provider,
    renderer,
    agent,
    confirmations,
    async cleanup() {
      await manager.close().catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true });
      await fixture.cleanup();
    },
  };
}

test('a destructive MCP tool is stopped by the approval gate and the loop continues', async () => {
  const ctx = await setup({
    responses: [
      response({ toolCalls: [toolCall('mcp_fixture_delete_item', { id: 'item-1' })] }),
      response({ content: 'I did not delete anything because approval was denied.' }),
    ],
    confirm: async () => false,
  });
  try {
    const summary = await ctx.agent.run('delete item-1 with the MCP server');
    assert.equal(summary.status, 'completed');
    assert.equal(ctx.confirmations.length, 1);
    const request = ctx.confirmations[0];
    assert.equal(request.tool, 'mcp_fixture_delete_item');
    assert.equal(request.label, 'mcp:fixture:delete_item');
    assert.equal(request.risk, 'destructive');
    assert.ok(request.preview.includes('external MCP server'), 'the preview says who performs the action');
    assert.ok(ctx.renderer.events.some((event) => event.event === 'toolDenied'));

    const denied = ctx.provider.calls[1].messages.find((message) => message.role === 'tool');
    assert.match(denied.content, /APPROVAL_DENIED/);
  } finally {
    await ctx.cleanup();
  }
});

test('an approved MCP write runs once and its result reaches the model', async () => {
  const ctx = await setup({
    responses: [
      response({ toolCalls: [toolCall('mcp_fixture_create_item', { title: 'from agent' })] }),
      response({ content: 'The MCP server created the item.' }),
    ],
    confirm: async () => true,
  });
  try {
    const summary = await ctx.agent.run('create an item through MCP');
    assert.equal(summary.status, 'completed');
    assert.equal(ctx.confirmations.length, 1);
    assert.equal(ctx.confirmations[0].risk, 'write');

    const toolMessage = ctx.provider.calls[1].messages.find((message) => message.role === 'tool');
    assert.match(toolMessage.content, /created from agent/);
    assert.match(toolMessage.content, /"server":"fixture"/);

    const start = ctx.renderer.events.find((event) => event.event === 'toolStart');
    assert.equal(start.payload.plugin, 'mcp-fixture');
    assert.deepEqual(start.payload.mcp, { server: 'fixture', tool: 'create_item' });
  } finally {
    await ctx.cleanup();
  }
});

test('a read-only MCP tool does not prompt, is offered to the model, and returns to the loop', async () => {
  const ctx = await setup({
    responses: [
      response({ toolCalls: [toolCall('mcp_fixture_search_items', { query: 'alpha' })] }),
      response({ content: 'Found one fixture item.' }),
    ],
  });
  try {
    const summary = await ctx.agent.run('search the fixture');
    assert.equal(summary.status, 'completed');
    assert.equal(ctx.confirmations.length, 0, 'read-only tools follow the existing no-prompt policy');

    const request = ctx.provider.calls[0];
    const offered = request.tools.find((entry) => entry.function.name === 'mcp_fixture_search_items');
    assert.ok(offered, 'the MCP tool is part of the provider tool list');
    assert.equal(offered.function.parameters.properties.query.type, 'string');

    const toolMessage = ctx.provider.calls[1].messages.find((message) => message.role === 'tool');
    assert.match(toolMessage.content, /Fixture alpha/);
  } finally {
    await ctx.cleanup();
  }
});

test('a server that drops mid-task produces a clear tool error instead of a stuck loop', async () => {
  const ctx = await setup({
    responses: [
      async () => {
        await ctx.manager.disconnect('fixture');
        return response({ toolCalls: [toolCall('mcp_fixture_search_items', { query: 'gone' })] });
      },
      response({ content: 'The MCP server was disconnected, so I stopped.' }),
    ],
  });
  try {
    const summary = await ctx.agent.run('search while the server goes away');
    assert.equal(summary.status, 'completed');
    const toolMessage = ctx.provider.calls[1].messages.find((message) => message.role === 'tool');
    assert.match(toolMessage.content, /UNKNOWN_TOOL/);
    assert.equal(summary.steps, 2);
  } finally {
    await ctx.cleanup();
  }
});

test('MCP tools and native tools coexist in one registry', async () => {
  const ctx = await setup({
    responses: [response({ content: 'done' })],
  });
  try {
    const names = ctx.registry.list().map((tool) => tool.name);
    assert.ok(names.includes('read_file'), 'built-in tools are untouched');
    assert.ok(names.includes('mcp_fixture_search_items'), 'MCP tools are additive');
    // The plugin bookkeeping survives /tools and the renderer lookup.
    assert.equal(ctx.registry.pluginFor('read_file'), null);
    assert.equal(ctx.registry.pluginFor('mcp_fixture_search_items').server, 'fixture');
    // No built-in name was shadowed.
    assert.equal(ctx.registry.list().filter((tool) => tool.name === 'read_file').length, 1);
    assert.ok(ctx.registry.toOpenAITools().every((entry) => entry.function.name.length <= 61));
  } finally {
    await ctx.cleanup();
  }
});
