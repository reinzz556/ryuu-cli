/**
 * MCP client transport layer.
 *
 * The official SDK owns the protocol (JSON-RPC framing, initialization,
 * capability negotiation, SSE resumption). This module adds only what the CLI
 * needs around it: a validated stdio spawn, an SSRF-checked HTTP endpoint,
 * bounded timeouts, redacted stderr capture, notification hooks for dynamic
 * tool lists, and a close path that never leaves a child process behind.
 *
 * One `McpConnection` maps to exactly one server. The manager owns lifecycle,
 * retries and the registry; nothing here writes to the registry.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readVersion } from '../utils/version.js';
import { McpError, isUnsupportedMethod, withDeadline } from './errors.js';
import { bearerHeaders, buildChildEnv, resolveExecutable, sanitizeHeaders, validateArgs, validateHttpUrl } from './security.js';
import { FileOAuthProvider } from './oauth.js';

const MAX_LIST_ITEMS = 500;
const MAX_LIST_PAGES = 20;

const CLIENT_INFO = { name: 'ryuu-agent-cli', version: readVersion() };

/**
 * Collect a paginated `list*` result up to a fixed bound.
 *
 * The SDK names the array after the request (`tools`, `resources`, `prompts`),
 * so the caller passes the key instead of assuming an `items` field.
 */
async function collectPages(fetchPage, key, { maxItems = MAX_LIST_ITEMS } = {}) {
  const items = [];
  let cursor;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const result = await fetchPage(cursor);
    if (Array.isArray(result?.[key])) items.push(...result[key]);
    cursor = result?.nextCursor;
    if (!cursor || items.length >= maxItems) break;
  }
  return items.slice(0, maxItems);
}

export class McpConnection {
  constructor({ server, client, transport, stderrRead, logger = null }) {
    this.server = server;
    this.client = client;
    this.transport = transport;
    this.stderrRead = stderrRead || null;
    this.logger = logger;
    this.closed = false;
    this.capabilities = client.getServerCapabilities?.() || {};
    this.serverVersion = client.getServerVersion?.() || null;
  }

  async listTools({ timeoutMs = 15_000, signal = null } = {}) {
    try {
      return await withDeadline(
        collectPages(
          (cursor) => this.client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs, signal }),
          'tools',
        ),
        { timeoutMs, signal, label: 'tools/list', server: this.server.name },
      );
    } catch (error) {
      if (isUnsupportedMethod(error)) return [];
      throw error;
    }
  }

  async listResources({ timeoutMs = 15_000, signal = null } = {}) {
    try {
      return await withDeadline(
        collectPages(
          (cursor) => this.client.listResources(cursor ? { cursor } : undefined, { timeout: timeoutMs, signal }),
          'resources',
        ),
        { timeoutMs, signal, label: 'resources/list', server: this.server.name },
      );
    } catch (error) {
      if (isUnsupportedMethod(error)) return [];
      throw error;
    }
  }

  async listPrompts({ timeoutMs = 15_000, signal = null } = {}) {
    try {
      return await withDeadline(
        collectPages(
          (cursor) => this.client.listPrompts(cursor ? { cursor } : undefined, { timeout: timeoutMs, signal }),
          'prompts',
        ),
        { timeoutMs, signal, label: 'prompts/list', server: this.server.name },
      );
    } catch (error) {
      if (isUnsupportedMethod(error)) return [];
      throw error;
    }
  }

  async readResource(uri, { timeoutMs = 30_000, signal = null } = {}) {
    return withDeadline(this.client.readResource({ uri }, { timeout: timeoutMs, signal }), {
      timeoutMs,
      signal,
      label: 'resources/read',
      server: this.server.name,
    });
  }

  async getPrompt(name, args = {}, { timeoutMs = 30_000, signal = null } = {}) {
    return withDeadline(this.client.getPrompt({ name, arguments: args }, { timeout: timeoutMs, signal }), {
      timeoutMs,
      signal,
      label: 'prompts/get',
      server: this.server.name,
    });
  }

  async callTool(name, args = {}, { timeoutMs = 60_000, signal = null } = {}) {
    return withDeadline(this.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs, signal }), {
      timeoutMs,
      signal,
      label: `tools/call ${name}`,
      server: this.server.name,
    });
  }

  async ping({ timeoutMs = 10_000, signal = null } = {}) {
    return withDeadline(this.client.ping({ timeout: timeoutMs, signal }), {
      timeoutMs,
      signal,
      label: 'ping',
      server: this.server.name,
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client.close();
    } catch {
      // The transport may already be gone.
    }
    try {
      await this.transport.close();
    } catch {
      // Best effort.
    }
  }
}

/**
 * Open one connection. Validation happens before anything is spawned or dialed.
 *
 * @param {object} server persisted server record
 * @param {object} options
 * @param {object} [options.secrets] private credentials (env/headers/token/oauth)
 * @param {object} [options.oauth] pre-built OAuthClientProvider (login flow)
 * @param {function} [options.persistOAuth] saves provider state to credentials
 */
export async function openConnection(
  server,
  {
    secrets = {},
    timeoutMs = null,
    signal = null,
    logger = null,
    onToolsChanged = null,
    onResourcesChanged = null,
    onPromptsChanged = null,
    onClose = null,
    onStderr = null,
    oauth = null,
    persistOAuth = null,
  } = {},
) {
  const connectTimeoutMs = timeoutMs || server.connectTimeoutMs || 15_000;
  const clientId = `${CLIENT_INFO.name}/mcp`;
  const client = new Client(
    { name: clientId, version: CLIENT_INFO.version },
    { capabilities: {} },
  );

  let transport = null;
  let stderrRead = null;
  try {
    if (server.transport === 'stdio') {
      const cwd = server.cwd ? String(server.cwd) : process.cwd();
      const command = await resolveExecutable(server.command, { cwd });
      const args = validateArgs(server.args || []);
      transport = new StdioClientTransport({
        command,
        args,
        cwd,
        env: buildChildEnv(secrets.env || {}),
        stderr: 'pipe',
      });
      const stream = transport.stderr;
      if (stream) {
        stderrRead = (handler) => {
          stream.setEncoding?.('utf8');
          stream.on('data', handler);
        };
      }
    } else {
      await validateHttpUrl(server.url, { allowPrivate: Boolean(server.allowPrivateNetwork), resolve: true });
      const headers = sanitizeHeaders({
        ...(secrets.headers || {}),
        ...(server.auth?.type === 'bearer' ? bearerHeaders(server.auth, secrets.token || '') : {}),
      });
      const authProvider =
        oauth ||
        (server.auth?.type === 'oauth'
          ? new FileOAuthProvider({
              server,
              oauth: secrets.oauth || {},
              persist: persistOAuth,
            })
          : undefined);
      transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers },
        ...(authProvider ? { authProvider } : {}),
        reconnectionOptions: {
          initialReconnectionDelay: 1000,
          maxReconnectionDelay: 8000,
          reconnectionDelayGrowFactor: 1.5,
          maxRetries: 2,
        },
      });
    }

    // Notifications must be wired before connect, so a server that announces a
    // change during initialization is not missed.
    const register = (schema, handler) => {
      if (typeof client.setNotificationHandler !== 'function') return;
      try {
        client.setNotificationHandler(schema, handler);
      } catch {
        // Older SDK builds: dynamic refresh still works through /mcp refresh.
      }
    };
    if (onToolsChanged) register(ToolListChangedNotificationSchema, () => onToolsChanged());
    if (onResourcesChanged) register(ResourceListChangedNotificationSchema, () => onResourcesChanged());
    if (onPromptsChanged) register(PromptListChangedNotificationSchema, () => onPromptsChanged());

    await withDeadline(client.connect(transport), {
      timeoutMs: connectTimeoutMs,
      signal,
      label: 'initialize handshake',
      server: server.name,
    });
  } catch (error) {
    try {
      await client.close();
    } catch {
      // ignore
    }
    try {
      await transport?.close();
    } catch {
      // ignore
    }
    throw error;
  }

  const connection = new McpConnection({ server, client, transport, stderrRead, logger });

  // A dropped transport is a state change, not a crash: the manager unregisters
  // or marks the server so the next tool call reports something actionable.
  try {
    client.onclose = () => {
      if (connection.closed) return;
      onClose?.();
    };
    client.onerror = (error) => {
      logger?.warn?.('mcp client error', { server: server.name, error: String(error?.message || error) });
    };
  } catch {
    // Assignment is best-effort across SDK builds.
  }

  if (stderrRead && typeof onStderr === 'function') {
    stderrRead((chunk) => {
      for (const line of String(chunk).split('\n').filter(Boolean)) onStderr(line);
    });
  }

  return connection;
}

/** Close a connection without throwing. */
export async function closeQuietly(connection) {
  if (!connection) return;
  try {
    await connection.close?.();
  } catch {
    // best-effort
  }
}

/** True when two server records describe the same endpoint/command. */
export function sameEndpoint(left, right) {
  if (!left || !right) return false;
  if (left.transport !== right.transport) return false;
  if (left.transport === 'stdio') {
    return left.command === right.command && JSON.stringify(left.args || []) === JSON.stringify(right.args || []);
  }
  return String(left.url) === String(right.url);
}

/** A short human label for transport configuration. */
export function describeTransport(server) {
  if (!server) return 'unknown';
  if (server.transport === 'stdio') {
    return ['stdio', server.command, ...(server.args || [])].filter(Boolean).join(' ').slice(0, 120);
  }
  return `http ${server.url}`;
}

export { McpError };
