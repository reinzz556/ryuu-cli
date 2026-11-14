/**
 * Local Streamable HTTP MCP server used by the Ryuu MCP tests.
 *
 * Stateless transport, bound to 127.0.0.1 on a random port. It prints
 * `{"port":N}` on stdout as soon as it listens. Every request must carry
 * `Authorization: Bearer fixture-token-123`, which lets the tests exercise real
 * bearer authentication without a network account.
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const TOKEN = 'fixture-token-123';

const server = new Server(
  { name: 'ryuu-http-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_deployments',
      description: 'List fixture deployments',
      inputSchema: {
        type: 'object',
        properties: { project: { type: 'string' } },
        required: ['project'],
      },
      annotations: { readOnlyHint: true },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const project = String(request.params?.arguments?.project || '');
  return { content: [{ type: 'text', text: `deployments for ${project}: none` }] };
});

// Stateful mode with one session: the SDK's stateless mode requires a fresh
// transport per request, which a test fixture does not need.
const httpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
await server.connect(httpTransport);

const httpServer = http.createServer(async (req, res) => {
  const auth = String(req.headers.authorization || '');
  if (auth !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  try {
    await httpTransport.handleRequest(req, res);
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error?.message || error) }));
    }
  }
});

httpServer.listen(0, '127.0.0.1', () => {
  const address = httpServer.address();
  process.stdout.write(`${JSON.stringify({ port: address.port })}\n`);
});

const shutdown = () => {
  httpServer.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
