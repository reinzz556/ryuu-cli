/**
 * Minimal MCP stdio server used to test the real StdioClientTransport path.
 * It implements one search tool and never touches the network.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'ryuu-stdio-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'fixture_search',
      description: 'Search the local fixture',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const query = String(request.params.arguments?.query || '');
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          results: [
            {
              title: `Fixture ${query}`,
              url: 'https://fixture.example/page',
              description: 'Served by the local stdio fixture.',
            },
          ],
        }),
      },
    ],
  };
});

await server.connect(new StdioServerTransport());
