import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry, defineTool } from '../../src/tools/registry.js';

const echoTool = defineTool({
  name: 'echo_tool',
  description: 'Echo a message back to the caller.',
  risk: 'read',
  schema: {
    type: 'object',
    properties: { message: { type: 'string', minLength: 1 } },
    required: ['message'],
    additionalProperties: false,
  },
  handler: async (args) => ({ echo: args.message }),
});

test('registers tools and exposes OpenAI-compatible schemas', () => {
  const registry = new ToolRegistry();
  registry.register(echoTool);
  assert.equal(registry.has('echo_tool'), true);
  const schemas = registry.toOpenAITools();
  assert.equal(schemas.length, 1);
  assert.equal(schemas[0].type, 'function');
  assert.equal(schemas[0].function.name, 'echo_tool');
  assert.equal(schemas[0].function.parameters.required[0], 'message');
});

test('rejects duplicate tool names', () => {
  const registry = new ToolRegistry();
  registry.register(echoTool);
  assert.throws(() => registry.register({ ...echoTool }), /collision/);
});

test('validates tool definitions', () => {
  assert.throws(() => defineTool({ ...echoTool, name: 'Bad-Name' }), /Invalid tool name/);
  assert.throws(() => defineTool({ ...echoTool, risk: 'root' }), /invalid risk/);
  assert.throws(() => defineTool({ ...echoTool, handler: null }), /handler function/);
  assert.throws(() => defineTool({ ...echoTool, schema: { type: 'string' } }), /object JSON schema/);
});

test('unknown tools cannot execute', async () => {
  const registry = new ToolRegistry();
  await assert.rejects(registry.execute('not_registered', {}), (e) => e.code === 'UNKNOWN_TOOL');
});

test('invalid arguments are rejected before the handler runs', async () => {
  let called = false;
  const registry = new ToolRegistry();
  registry.register({ ...echoTool, handler: async () => { called = true; } });
  await assert.rejects(registry.execute('echo_tool', {}), (e) => e.code === 'VALIDATION_FAILED' && /message/.test(e.message));
  await assert.rejects(registry.execute('echo_tool', { message: 5 }), (e) => e.code === 'VALIDATION_FAILED');
  assert.equal(called, false);
});

test('handler receives validated args and result metadata', async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool);
  const { result, durationMs } = await registry.execute('echo_tool', { message: 'hi' });
  assert.deepEqual(result, { echo: 'hi' });
  assert.equal(typeof durationMs, 'number');
});

test('handler errors become ToolError but keep validation codes', async () => {
  const registry = new ToolRegistry();
  registry.register({ ...echoTool, handler: async () => { throw new Error('boom'); } });
  await assert.rejects(registry.execute('echo_tool', { message: 'x' }), (e) => e.code === 'TOOL_ERROR' && /boom/.test(e.message));
});

test('plugins validate and detect collisions', () => {
  const registry = new ToolRegistry();
  registry.register(echoTool);
  const plugin = {
    name: 'demo',
    version: '1.0.0',
    tools: [{
      name: 'plugin_echo',
      description: 'A plugin tool that echoes input.',
      risk: 'read',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => ({ ok: true }),
    }],
  };
  const registered = registry.registerPlugin(plugin);
  assert.deepEqual(registered.tools, ['plugin_echo']);
  assert.equal(registry.has('plugin_echo'), true);
  assert.throws(() => registry.registerPlugin(plugin), /already registered/);
  assert.throws(
    () => registry.registerPlugin({ ...plugin, name: 'demo2', tools: [echoTool] }),
    /collision/,
  );
  assert.throws(() => registry.registerPlugin({ name: 'bad name', tools: [] }), /Invalid plugin name/);
});
