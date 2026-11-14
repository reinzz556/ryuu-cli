/**
 * Local OAuth + Streamable HTTP MCP server used by the Ryuu OAuth test.
 *
 * It implements just enough of RFC 9728 / RFC 8414 and the MCP authorization
 * flow to exercise the real SDK client end to end: protected-resource metadata,
 * authorization-server metadata, dynamic client registration, PKCE (S256), the
 * authorization redirect, the token exchange and a bearer-protected MCP
 * endpoint. No external account is involved.
 *
 * Prints `{"port":N}` on stdout once it is listening.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const ACCESS_TOKEN = 'oauth-access-token';
const REFRESH_TOKEN = 'oauth-refresh-token';

const codes = new Map();
let baseUrl = 'http://127.0.0.1';

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function pkceMatches(verifier, challenge) {
  const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
  return computed === challenge;
}

/** One MCP server + transport pair per session (reconnect creates a new one). */
async function createMcpSession() {
  const mcpServer = new Server(
    { name: 'ryuu-oauth-fixture', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'whoami',
        description: 'Report the OAuth identity of this fixture',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
      },
    ],
  }));
  mcpServer.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: 'text', text: JSON.stringify({ user: 'oauth-fixture', access: 'valid' }) }],
  }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
  await mcpServer.connect(transport);
  return { mcpServer, transport };
}

const sessions = new Map();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, baseUrl);
  const path = url.pathname;

  // OAuth discovery: the SDK probes path-based and root well-known URLs.
  if (req.method === 'GET' && path.startsWith('/.well-known/oauth-protected-resource')) {
    json(res, 200, {
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl],
      scopes_supported: ['mcp:read'],
      bearer_methods_supported: ['header'],
    });
    return;
  }
  if (
    req.method === 'GET' &&
    (path.startsWith('/.well-known/oauth-authorization-server') || path.startsWith('/.well-known/openid-configuration'))
  ) {
    json(res, 200, {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp:read'],
    });
    return;
  }
  if (req.method === 'POST' && path === '/register') {
    let body = {};
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      json(res, 400, { error: 'invalid_client_metadata' });
      return;
    }
    json(res, 201, {
      client_id: 'ryuu-oauth-test-client',
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: body.redirect_uris || [],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    return;
  }
  if (req.method === 'GET' && path === '/authorize') {
    const redirectUri = url.searchParams.get('redirect_uri');
    const challenge = url.searchParams.get('code_challenge') || '';
    const state = url.searchParams.get('state') || '';
    if (!redirectUri) {
      json(res, 400, { error: 'invalid_request' });
      return;
    }
    const code = crypto.randomBytes(16).toString('hex');
    codes.set(code, { challenge, redirectUri });
    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    if (state) target.searchParams.set('state', state);
    res.writeHead(302, { location: target.toString() });
    res.end();
    return;
  }
  if (req.method === 'POST' && path === '/token') {
    const form = new URLSearchParams(await readBody(req));
    const grant = form.get('grant_type');
    if (grant === 'authorization_code') {
      const entry = codes.get(form.get('code') || '');
      if (!entry) {
        json(res, 400, { error: 'invalid_grant' });
        return;
      }
      codes.delete(form.get('code'));
      if (!pkceMatches(form.get('code_verifier') || '', entry.challenge)) {
        json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return;
      }
      json(res, 200, {
        access_token: ACCESS_TOKEN,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: REFRESH_TOKEN,
        scope: 'mcp:read',
      });
      return;
    }
    if (grant === 'refresh_token') {
      if (form.get('refresh_token') !== REFRESH_TOKEN) {
        json(res, 400, { error: 'invalid_grant' });
        return;
      }
      json(res, 200, {
        access_token: ACCESS_TOKEN,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: REFRESH_TOKEN,
        scope: 'mcp:read',
      });
      return;
    }
    json(res, 400, { error: 'unsupported_grant_type' });
    return;
  }

  if (path === '/mcp') {
    const auth = String(req.headers.authorization || '');
    if (auth !== `Bearer ${ACCESS_TOKEN}`) {
      json(res, 401, { error: 'unauthorized' }, {
        'www-authenticate': `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`,
      });
      return;
    }
    try {
      const sessionId = req.headers['mcp-session-id'];
      if (!sessionId) {
        // Initialization: a new MCP server instance per session.
        const { transport } = await createMcpSession();
        await transport.handleRequest(req, res);
        if (transport.sessionId) {
          sessions.set(transport.sessionId, transport);
          transport.onclose = () => sessions.delete(transport.sessionId);
        }
        return;
      }
      const existing = sessions.get(String(sessionId));
      if (!existing) {
        json(res, 404, { error: 'session_not_found' });
        return;
      }
      await existing.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) json(res, 500, { error: String(error?.message || error) });
    }
    return;
  }

  json(res, 404, { error: 'not_found' });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  process.stdout.write(`${JSON.stringify({ port: address.port })}\n`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
