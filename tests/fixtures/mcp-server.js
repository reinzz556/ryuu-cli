/**
 * Local MCP stdio server used by the Ryuu MCP tests.
 *
 * It exercises every protocol surface the client implements without touching
 * the network: tools with each risk shape, an error result, a slow call for
 * timeouts, image/resource content, resources, prompts, environment passing and
 * a `notifications/tools/list_changed` announcement.
 */
import process from 'node:process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const tools = [
  {
    name: 'search_items',
    description: 'Search fixture items by query',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search text' } },
      required: ['query'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'create_item',
    description: 'Create one fixture item',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, body: { type: 'string' } },
      required: ['title'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'delete_item',
    description: 'Delete a fixture item permanently',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: 'inspect_state',
    description: 'Inspect internal fixture state (read-only annotation)',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'quiet_writer',
    description: 'Update fixture state while claiming to be read-only',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    // A deliberately lying annotation: the client must not trust it alone.
    annotations: { readOnlyHint: true },
  },
  {
    name: 'failing_tool',
    description: 'Always returns an MCP error result',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'slow_tool',
    description: 'Sleeps before answering (timeout test)',
    inputSchema: { type: 'object', properties: { ms: { type: 'integer' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'image_tool',
    description: 'Returns one tiny PNG image',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'rich_tool',
    description: 'Returns text, an embedded resource and a resource link',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_env',
    description: 'Report selected environment values and the process id',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'announce_tool',
    description: 'Adds dynamic_tool and announces a tools/list_changed',
    inputSchema: { type: 'object', properties: {} },
  },
];

let dynamicAdded = false;

const server = new Server(
  { name: 'ryuu-mcp-fixture', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params?.name;
  const args = request.params?.arguments || {};
  if (name === 'search_items') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ results: [{ id: 'item-1', title: `Fixture ${args.query || ''}` }] }),
        },
      ],
    };
  }
  if (name === 'create_item') {
    return { content: [{ type: 'text', text: `created ${args.title}` }] };
  }
  if (name === 'delete_item') {
    return { content: [{ type: 'text', text: `deleted ${args.id}` }] };
  }
  if (name === 'inspect_state') {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, dynamicAdded }) }], structuredContent: { ok: true } };
  }
  if (name === 'quiet_writer') {
    return { content: [{ type: 'text', text: `updated ${args.value || ''}` }] };
  }
  if (name === 'failing_tool') {
    return { isError: true, content: [{ type: 'text', text: 'fixture failure: the item does not exist' }] };
  }
  if (name === 'slow_tool') {
    const ms = Math.max(0, Math.min(10_000, Number(args.ms) || 3000));
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { content: [{ type: 'text', text: `slept ${ms}ms` }] };
  }
  if (name === 'image_tool') {
    return { content: [{ type: 'image', data: PNG_1X1, mimeType: 'image/png' }] };
  }
  if (name === 'rich_tool') {
    return {
      content: [
        { type: 'text', text: 'rich payload' },
        { type: 'resource', resource: { uri: 'fixture://readme', mimeType: 'text/plain', text: 'embedded resource body' } },
        { type: 'resource_link', uri: 'fixture://binary', name: 'Binary fixture', mimeType: 'application/octet-stream' },
        { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
      ],
      structuredContent: { answer: 42 },
    };
  }
  if (name === 'get_env') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            pid: process.pid,
            secret: process.env.MCP_FIXTURE_SECRET || '',
            pathVisible: Boolean(process.env.PATH),
            ryuuVisible: Boolean(process.env.RYUU_TEST_SECRET),
          }),
        },
      ],
    };
  }
  if (name === 'announce_tool') {
    if (!dynamicAdded) {
      dynamicAdded = true;
      tools.push({
        name: 'dynamic_tool',
        description: 'Appears after a tools/list_changed notification',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
      });
      await server.sendToolListChanged();
    }
    return { content: [{ type: 'text', text: 'announced' }] };
  }
  if (name === 'dynamic_tool') {
    return { content: [{ type: 'text', text: 'dynamic tool ran' }] };
  }
  throw new Error(`unknown fixture tool: ${name}`);
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    { uri: 'fixture://readme', name: 'Readme', mimeType: 'text/plain' },
    { uri: 'fixture://binary', name: 'Binary', mimeType: 'application/octet-stream' },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params?.uri;
  if (uri === 'fixture://readme') {
    return { contents: [{ uri, mimeType: 'text/plain', text: 'fixture readme content' }] };
  }
  if (uri === 'fixture://binary') {
    return { contents: [{ uri, mimeType: 'application/octet-stream', blob: PNG_1X1 }] };
  }
  throw new Error(`unknown resource: ${uri}`);
});

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: 'greet',
      description: 'Greet one person',
      arguments: [{ name: 'who', description: 'Name', required: true }],
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  if (request.params?.name !== 'greet') throw new Error('unknown prompt');
  const who = request.params?.arguments?.who || 'world';
  return {
    description: 'Greeting prompt',
    messages: [{ role: 'user', content: { type: 'text', text: `Hello ${who}` } }],
  };
});

await server.connect(new StdioServerTransport());
