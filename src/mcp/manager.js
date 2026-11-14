/**
 * McpManager — lifecycle owner for every configured MCP server.
 *
 * Responsibilities:
 *   - read/validate `servers.json`, connect enabled servers on startup;
 *   - translate MCP tools into Ryuu tools and keep the registry in sync when a
 *     server announces `notifications/tools/list_changed`;
 *   - route a tool call to the right connection, with reconnect-on-demand;
 *   - expose resources/prompts for inspection and for the agent;
 *   - keep per-server state, capabilities and a redacted log;
 *   - close every connection (and child process) on shutdown.
 *
 * Secrets are read only at connect time and never stored on a public object.
 */

import fsp from 'node:fs/promises';
import {
  MCP_DEFAULTS,
  appendServerLog,
  credentialsFile,
  getServerRecord,
  listServers,
  logFile,
  readSecrets,
  readServerLog,
  recordServerState,
  removeServer as removeServerRecord,
  serversFile,
  setServerEnabled,
  splitServerInput,
  upsertServer,
} from './config.js';
import { openConnection } from './client.js';
import { classifyToolRisk, mcpToolDefinition, normalizeCallResult } from './convert.js';
import { McpError, briefReason, mapMcpError } from './errors.js';
import { buildToolName, displayToolName, serverPluginName } from './naming.js';
import { authorizeServer, oauthPersister } from './oauth.js';
import { resolveExecutable, validateHttpUrl } from './security.js';
import { createRedactor } from '../utils/redaction.js';
import { readVersion } from '../utils/version.js';

const DISCOVERY_TIMEOUT_MS = 15_000;
const RECONNECT_COOLDOWN_MS = 1500;

export class McpManager {
  constructor({
    registry,
    logger = null,
    dir = null,
    interactive = false,
    onEvent = null,
    version = readVersion(),
    // An embedder/test can receive the authorization URL directly instead of a
    // browser being opened. Returning a promise delays the flow until it settles.
    onAuthUrl = null,
    openBrowser = true,
  } = {}) {
    if (!registry) throw new Error('McpManager requires a tool registry.');
    this.registry = registry;
    this.logger = logger;
    this.dir = dir;
    this.interactive = Boolean(interactive);
    this.onEvent = onEvent;
    this.version = version;
    this.onAuthUrl = typeof onAuthUrl === 'function' ? onAuthUrl : null;
    this.openBrowser = Boolean(openBrowser);
    this.runtime = new Map();
    this.pendingConnects = new Map();
    this.closed = false;
    this.startPromise = null;
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Connect the servers marked enabled + autoConnect. Never throws: a broken
   * third-party server must not stop Ryuu from starting.
   */
  async start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      let servers;
      try {
        servers = await listServers({ dir: this.dir });
      } catch (error) {
        this.logger?.warn?.('mcp configuration could not be read', { error: error.message });
        this.#emit('configError', { error: error.message });
        return { configured: 0, connected: 0, failed: 0 };
      }
      const targets = servers.filter((server) => server.enabled && server.autoConnect);
      let connected = 0;
      let failed = 0;
      await Promise.all(
        targets.map(async (server) => {
          try {
            await this.connect(server.name);
            connected += 1;
          } catch (error) {
            failed += 1;
            this.logger?.warn?.('mcp server failed to connect at startup', {
              server: server.name,
              code: error.code,
              error: briefReason(error, 160),
            });
            this.#log(server.name, 'ERROR', `startup connect failed: ${briefReason(error)}`);
            await recordServerState(
              server.name,
              { state: 'error', error: briefReason(error, 300), toolCount: 0 },
              { dir: this.dir },
            ).catch(() => {});
            this.#emit('serverError', { name: server.name, error: briefReason(error) });
          }
        }),
      );
      return { configured: servers.length, connected, failed };
    })();
    return this.startPromise;
  }

  /** Runtime state for one server (never contains secrets). */
  stateOf(name) {
    return this.runtime.get(name) || null;
  }

  #runtimeFor(name) {
    let entry = this.runtime.get(name);
    if (!entry) {
      entry = {
        name,
        state: 'disconnected',
        connection: null,
        tools: [],
        resources: [],
        prompts: [],
        capabilities: {},
        serverVersion: null,
        error: null,
        connectedAt: null,
        lastAttemptAt: 0,
        redact: (value) => value,
      };
      this.runtime.set(name, entry);
    }
    return entry;
  }

  #emit(type, payload = {}) {
    if (typeof this.onEvent !== 'function') return;
    try {
      this.onEvent({ type, ...payload });
    } catch {
      // A renderer error must not break the connection.
    }
  }

  #log(name, level, message) {
    const entry = this.runtime.get(name);
    const redact = entry?.redact || ((value) => value);
    appendServerLog(name, `${level} ${redact(String(message))}`, { dir: this.dir }).catch(() => {});
  }

  #redactorFor(secrets = {}) {
    const values = [
      secrets.token,
      ...Object.values(secrets.headers || {}),
      ...Object.values(secrets.env || {}),
      secrets.oauth?.tokens?.access_token,
      secrets.oauth?.tokens?.refresh_token,
    ].filter((value) => typeof value === 'string' && value.length >= 4);
    return createRedactor(values);
  }

  /**
   * Connect one server and register its tools.
   *
   * @param {string} name
   * @param {{signal?: AbortSignal, interactive?: boolean, allowLogin?: boolean}} options
   */
  async connect(name, options = {}) {
    const key = String(name);
    // Startup and a user command can race on the same server; both wait for the
    // same connection attempt instead of spawning two child processes.
    const pending = this.pendingConnects.get(key);
    if (pending) return pending;
    const promise = this.#connect(key, options);
    this.pendingConnects.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.pendingConnects.get(key) === promise) this.pendingConnects.delete(key);
    }
  }

  async #connect(name, { signal = null, interactive = this.interactive, allowLogin = true } = {}) {
    if (this.closed) {
      throw new McpError('MCP manager is shutting down.', { code: 'MCP_SHUTDOWN' });
    }
    const record = await getServerRecord(name, { dir: this.dir });
    if (!record) throw new McpError(`MCP server ${name} is not configured. Run /mcp add.`, { code: 'MCP_NOT_CONFIGURED' });
    if (!record.enabled) {
      throw new McpError(`MCP server ${name} is disabled. Enable it with /mcp enable ${name}.`, { code: 'MCP_DISABLED' });
    }
    const entry = this.#runtimeFor(name);
    if (entry.state === 'connected' && entry.connection) return this.info(name);

    entry.state = 'connecting';
    entry.error = null;
    entry.lastAttemptAt = Date.now();
    this.#emit('serverConnecting', { name });

    let secrets = await readSecrets(name, { dir: this.dir });
    entry.redact = this.#redactorFor(secrets);

    try {
      if (record.transport === 'http' && record.auth?.type === 'oauth') {
        const oauth = secrets.oauth || {};
        const hasToken = Boolean(oauth.tokens?.access_token || oauth.tokens?.refresh_token);
        if (!hasToken) {
          if (!interactive || !allowLogin) {
            throw new McpError(
              `MCP server ${name} needs OAuth authorization. Run /mcp connect ${name} in an interactive session.`,
              { code: 'MCP_AUTH_REQUIRED' },
            );
          }
          await authorizeServer({
            server: record,
            oauth,
            persist: oauthPersister(name, this.dir),
            open: this.openBrowser && !this.onAuthUrl,
            onUrl: (url) => {
              this.#emit('oauthUrl', { name, url });
              if (this.onAuthUrl) return this.onAuthUrl(url, name);
              return undefined;
            },
          });
          secrets = await readSecrets(name, { dir: this.dir });
          entry.redact = this.#redactorFor(secrets);
        }
      }

      const connection = await openConnection(record, {
        secrets,
        timeoutMs: record.connectTimeoutMs,
        signal,
        logger: this.logger,
        persistOAuth: oauthPersister(name, this.dir),
        onStderr: (line) => {
          this.#log(name, 'STDERR', line.slice(0, 2000));
        },
        onToolsChanged: () => {
          this.refreshTools(name).catch((error) => {
            this.#log(name, 'WARN', `tools/list_changed refresh failed: ${briefReason(error)}`);
          });
        },
        onResourcesChanged: () => {
          this.refreshResources(name).catch(() => {});
        },
        onPromptsChanged: () => {
          this.refreshPrompts(name).catch(() => {});
        },
        onClose: () => {
          const current = this.runtime.get(name);
          if (!current || current.connection !== connection || this.closed) return;
          current.state = 'disconnected';
          current.connection = null;
          current.error = 'connection closed by the server';
          this.#log(name, 'WARN', 'connection closed by the server');
          this.#emit('serverDisconnected', { name });
        },
      });

      if (this.closed) {
        await connection.close().catch(() => {});
        throw new McpError('MCP manager is shutting down.', { code: 'MCP_SHUTDOWN' });
      }
      entry.connection = connection;
      entry.capabilities = connection.capabilities || {};
      entry.serverVersion = connection.serverVersion || null;

      const tools = await this.#discoverTools(connection, record);
      entry.tools = tools;
      this.#registerTools(record, tools);

      entry.resources = entry.capabilities.resources ? await connection.listResources({ timeoutMs: DISCOVERY_TIMEOUT_MS }).catch(() => []) : [];
      entry.prompts = entry.capabilities.prompts ? await connection.listPrompts({ timeoutMs: DISCOVERY_TIMEOUT_MS }).catch(() => []) : [];

      entry.state = 'connected';
      entry.error = null;
      entry.connectedAt = new Date().toISOString();
      await recordServerState(
        name,
        {
          state: 'connected',
          connectedAt: entry.connectedAt,
          error: null,
          toolCount: tools.length,
          resourceCount: entry.resources.length,
          promptCount: entry.prompts.length,
          capabilities: entry.capabilities,
          serverVersion: entry.serverVersion,
        },
        { dir: this.dir },
      ).catch(() => {});
      this.#log(name, 'INFO', `connected (${tools.length} tool(s), ${entry.resources.length} resource(s), ${entry.prompts.length} prompt(s))`);
      this.#emit('serverConnected', { name, tools: tools.length });
      return this.info(name);
    } catch (error) {
      const mapped = mapMcpError(error, { server: name, phase: 'connect' });
      entry.state = 'error';
      entry.connection = null;
      entry.error = briefReason(mapped, 300);
      this.#log(name, 'ERROR', `connect failed: ${entry.error}`);
      await recordServerState(name, { state: 'error', error: entry.error }, { dir: this.dir }).catch(() => {});
      this.#emit('serverError', { name, error: entry.error });
      throw mapped;
    }
  }

  async #discoverTools(connection, record) {
    if (connection.capabilities && connection.capabilities.tools === undefined) return [];
    const listed = await connection.listTools({ timeoutMs: Math.min(record.connectTimeoutMs, DISCOVERY_TIMEOUT_MS) });
    return (Array.isArray(listed) ? listed : [])
      .filter((tool) => tool && typeof tool.name === 'string' && tool.name.trim())
      .slice(0, 200);
  }

  /**
   * Re-list one server's tools and swap the registry entries atomically.
   * Called by the notification handler and by `/mcp refresh`.
   */
  async refreshTools(name) {
    const entry = this.runtime.get(name);
    const record = await getServerRecord(name, { dir: this.dir });
    if (!entry || !record) return { tools: 0 };
    if (!entry.connection) {
      await this.connect(name);
      return { tools: entry.tools.length };
    }
    const tools = await this.#discoverTools(entry.connection, record);
    entry.tools = tools;
    this.#registerTools(record, tools);
    this.#log(name, 'INFO', `tool list refreshed (${tools.length} tool(s))`);
    this.#emit('serverRefreshed', { name, tools: tools.length });
    return { tools: tools.length };
  }

  async refreshResources(name) {
    const entry = this.runtime.get(name);
    if (!entry?.connection || !entry.capabilities.resources) return { resources: 0 };
    entry.resources = await entry.connection.listResources({ timeoutMs: DISCOVERY_TIMEOUT_MS }).catch(() => []);
    return { resources: entry.resources.length };
  }

  async refreshPrompts(name) {
    const entry = this.runtime.get(name);
    if (!entry?.connection || !entry.capabilities.prompts) return { prompts: 0 };
    entry.prompts = await entry.connection.listPrompts({ timeoutMs: DISCOVERY_TIMEOUT_MS }).catch(() => []);
    return { prompts: entry.prompts.length };
  }

  #registerTools(record, tools) {
    const pluginName = serverPluginName(record.name);
    this.registry.unregisterPlugin?.(pluginName);
    if (!tools || tools.length === 0) return 0;

    const taken = new Set(this.registry.list().map((tool) => tool.name));
    const displayNames = {};
    const definitions = tools.map((tool) => {
      const registeredName = buildToolName(record.name, tool.name, taken);
      taken.add(registeredName);
      displayNames[registeredName] = tool.name;
      return mcpToolDefinition({
        server: record,
        tool,
        registeredName,
        call: (args, ctx) => this.callTool(record.name, tool.name, args, ctx),
      });
    });

    this.registry.registerPlugin({
      name: pluginName,
      version: this.version,
      mcp: true,
      server: record.name,
      displayNames,
      tools: definitions,
    });
    return definitions.length;
  }

  /* ------------------------------------------------------------------ */
  /* calls                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Call one MCP tool. The registered handler routes here.
   *
   * A disconnected server is reconnected once, so a transient drop does not
   * force the user to restart Ryuu. If reconnect fails the error names the
   * server and says how to recover; the agent loop receives a normal tool error
   * and continues.
   */
  async callTool(serverName, toolName, args = {}, ctx = {}) {
    const record = await getServerRecord(serverName, { dir: this.dir });
    if (!record) {
      throw new McpError(`MCP server ${serverName} was removed while its tool was registered.`, { code: 'MCP_NOT_CONFIGURED' });
    }
    let entry = this.#runtimeFor(serverName);
    if (!entry.connection) {
      if (Date.now() - entry.lastAttemptAt < RECONNECT_COOLDOWN_MS) {
        throw new McpError(
          `MCP server ${serverName} is disconnected (${entry.error || 'no connection'}). Try again shortly or run /mcp reconnect ${serverName}.`,
          { code: 'MCP_NOT_CONNECTED', retryable: true },
        );
      }
      try {
        await this.connect(serverName, { signal: ctx.signal || null });
      } catch (error) {
        throw new McpError(
          `MCP server ${serverName} is disconnected and could not be reconnected: ${briefReason(error)} Run /mcp status ${serverName} for details.`,
          { code: 'MCP_NOT_CONNECTED', cause: error, retryable: true },
        );
      }
      entry = this.#runtimeFor(serverName);
    }

    const known = entry.tools.find((tool) => tool.name === toolName);
    if (!known) {
      // The server may have dropped the tool since discovery: refresh once.
      await this.refreshTools(serverName).catch(() => {});
      if (!entry.tools.some((tool) => tool.name === toolName)) {
        throw new McpError(
          `MCP server ${serverName} no longer offers the tool "${toolName}". Run /mcp tools ${serverName} to see the current list.`,
          { code: 'MCP_TOOL_MISSING', details: { server: serverName, tool: toolName } },
        );
      }
    }

    const started = Date.now();
    try {
      const result = await entry.connection.callTool(toolName, args, {
        timeoutMs: record.callTimeoutMs,
        signal: ctx.signal || null,
      });
      const normalized = normalizeCallResult(result, {
        server: serverName,
        tool: toolName,
        maxBytes: record.maxResultBytes,
      });
      this.#log(
        serverName,
        'INFO',
        `tools/call ${toolName} ok ${Date.now() - started}ms (${normalized.text.length} chars, ${normalized.images.length} image(s))`,
      );
      return normalized;
    } catch (error) {
      const mapped = mapMcpError(error, { server: serverName, phase: 'call' });
      this.#log(serverName, 'ERROR', `tools/call ${toolName} failed: ${briefReason(mapped)}`);
      throw mapped;
    }
  }

  async readResource(name, uri, { signal = null } = {}) {
    const { record, entry } = await this.#ensure(name, signal);
    const result = await entry.connection
      .readResource(uri, { timeoutMs: record.callTimeoutMs, signal })
      .catch((error) => {
        throw mapMcpError(error, { server: name, phase: 'resources/read' });
      });
    this.#log(name, 'INFO', `resources/read ${uri}`);
    return result;
  }

  async getPrompt(name, promptName, args = {}, { signal = null } = {}) {
    const { record, entry } = await this.#ensure(name, signal);
    const result = await entry.connection
      .getPrompt(promptName, args, { timeoutMs: record.callTimeoutMs, signal })
      .catch((error) => {
        throw mapMcpError(error, { server: name, phase: 'prompts/get' });
      });
    this.#log(name, 'INFO', `prompts/get ${promptName}`);
    return result;
  }

  async #ensure(name, signal = null) {
    const record = await getServerRecord(name, { dir: this.dir });
    if (!record) throw new McpError(`MCP server ${name} is not configured.`, { code: 'MCP_NOT_CONFIGURED' });
    let entry = this.#runtimeFor(name);
    if (!entry.connection) {
      await this.connect(name, { signal });
      entry = this.#runtimeFor(name);
    }
    return { record, entry };
  }

  /* ------------------------------------------------------------------ */
  /* server management                                                   */
  /* ------------------------------------------------------------------ */

  async addServer(input) {
    const { record } = splitServerInput(input);
    // Validate the process/endpoint before anything is persisted.
    if (record.transport === 'stdio') {
      if (record.cwd) {
        const stats = await fsp.stat(record.cwd).catch(() => null);
        if (!stats?.isDirectory()) {
          throw new McpError(`MCP working directory does not exist: ${record.cwd}`, { code: 'MCP_CWD_INVALID' });
        }
      }
      await resolveExecutable(record.command, { cwd: record.cwd || process.cwd() });
    } else {
      await validateHttpUrl(record.url, { allowPrivate: record.allowPrivateNetwork, resolve: false });
    }
    return upsertServer(input, { dir: this.dir });
  }

  async removeServer(name) {
    await this.disconnect(name, { persist: false }).catch(() => {});
    const removed = await removeServerRecord(name, { dir: this.dir });
    this.runtime.delete(name);
    return removed;
  }

  async setEnabled(name, enabled) {
    const record = await setServerEnabled(name, enabled, { dir: this.dir });
    if (!enabled) {
      await this.disconnect(name);
      this.#log(name, 'INFO', 'server disabled');
      return record;
    }
    try {
      await this.connect(name);
    } catch (error) {
      this.#log(name, 'WARN', `enabled but not connected: ${briefReason(error)}`);
    }
    return record;
  }

  async disconnect(name, { persist = true } = {}) {
    const entry = this.runtime.get(name);
    const pluginName = serverPluginName(name);
    this.registry.unregisterPlugin?.(pluginName);
    if (entry?.connection) {
      await entry.connection.close().catch(() => {});
      this.#log(name, 'INFO', 'disconnected');
    }
    if (entry) {
      entry.connection = null;
      entry.state = 'disconnected';
      entry.tools = [];
      entry.connectedAt = null;
    }
    if (persist) await recordServerState(name, { state: 'disconnected' }, { dir: this.dir }).catch(() => {});
    this.#emit('serverDisconnected', { name });
    return true;
  }

  async reconnect(name) {
    await this.disconnect(name);
    return this.connect(name);
  }

  async restart(name) {
    return this.reconnect(name);
  }

  /** Refresh tools (and re-list resources/prompts) for one server. */
  async refresh(name) {
    const entry = this.runtime.get(name);
    if (!entry?.connection) {
      const described = await this.connect(name);
      return {
        tools: described.runtime.tools.length,
        resources: described.runtime.resources.length,
        prompts: described.runtime.prompts.length,
        refreshed: true,
      };
    }
    const tools = await this.refreshTools(name);
    const [resources, prompts] = await Promise.all([this.refreshResources(name), this.refreshPrompts(name)]);
    return { tools: tools.tools, resources: resources.resources, prompts: prompts.prompts };
  }

  /** Probe a server without touching the live connection or the registry. */
  async test(name, { signal = null } = {}) {
    const record = await getServerRecord(name, { dir: this.dir });
    if (!record) throw new McpError(`MCP server ${name} is not configured.`, { code: 'MCP_NOT_CONFIGURED' });
    const secrets = await readSecrets(name, { dir: this.dir });
    const started = Date.now();
    let connection = null;
    try {
      if (record.auth?.type === 'oauth' && !secrets.oauth?.tokens?.access_token && !secrets.oauth?.tokens?.refresh_token) {
        throw new McpError(`OAuth authorization is required. Run /mcp connect ${name} to authorize.`, {
          code: 'MCP_AUTH_REQUIRED',
        });
      }
      connection = await openConnection(record, {
        secrets,
        timeoutMs: Math.min(record.connectTimeoutMs, 15_000),
        signal,
        persistOAuth: oauthPersister(name, this.dir),
      });
      const tools = await connection.listTools({ timeoutMs: DISCOVERY_TIMEOUT_MS });
      const resources = connection.capabilities.resources ? await connection.listResources({ timeoutMs: DISCOVERY_TIMEOUT_MS }).catch(() => []) : [];
      const prompts = connection.capabilities.prompts ? await connection.listPrompts({ timeoutMs: DISCOVERY_TIMEOUT_MS }).catch(() => []) : [];
      return {
        ok: true,
        name,
        durationMs: Date.now() - started,
        capabilities: connection.capabilities,
        serverVersion: connection.serverVersion,
        tools: tools.map((tool) => ({ name: tool.name, risk: classifyToolRisk(tool, record) })),
        resources: resources.length,
        prompts: prompts.length,
      };
    } catch (error) {
      const mapped = mapMcpError(error, { server: name, phase: 'connect' });
      return { ok: false, name, durationMs: Date.now() - started, error: briefReason(mapped), code: mapped.code };
    } finally {
      await connection?.close().catch(() => {});
    }
  }

  /** Public server record plus live state. No secret is included. */
  async info(name) {
    const record = await getServerRecord(name, { dir: this.dir });
    if (!record) throw new McpError(`MCP server ${name} is not configured.`, { code: 'MCP_NOT_CONFIGURED' });
    const entry = this.runtime.get(name);
    const tools = (entry?.tools || []).map((tool) => ({
      name: tool.name,
      display: displayToolName(name, tool.name),
      risk: classifyToolRisk(tool, record),
      description: String(tool.description || '').replace(/\s+/g, ' ').slice(0, 160),
    }));
    return {
      server: publicRecord(record),
      runtime: {
        state: entry?.state || 'disconnected',
        connectedAt: entry?.connectedAt || record.last?.connectedAt || null,
        error: entry?.error || record.last?.error || null,
        capabilities: entry?.capabilities || record.last?.capabilities || {},
        serverVersion: entry?.serverVersion || record.last?.serverVersion || null,
        tools,
        resources: (entry?.resources || []).map((item) => ({ uri: item.uri, name: item.name || null, mimeType: item.mimeType || null })),
        prompts: (entry?.prompts || []).map((item) => ({
          name: item.name,
          description: String(item.description || '').replace(/\s+/g, ' ').slice(0, 160),
          arguments: Array.isArray(item.arguments) ? item.arguments.map((arg) => ({ name: arg.name, required: Boolean(arg.required) })) : [],
        })),
      },
      paths: {
        servers: serversFile(this.dir),
        log: logFile(name, this.dir),
        credentials: credentialsFile(name, this.dir),
      },
    };
  }

  /** Compact rows for `/mcp status` and `/mcp list`. */
  async status() {
    const servers = await listServers({ dir: this.dir });
    const rows = servers.map((server) => {
      const entry = this.runtime.get(server.name);
      // A disabled server is disabled even when a runtime entry from an earlier
      // connection still says "disconnected".
      const state = server.enabled ? entry?.state || 'disconnected' : 'disabled';
      return {
        name: server.name,
        state,
        enabled: Boolean(server.enabled),
        transport: server.transport,
        tools: entry?.tools?.length ?? server.last?.toolCount ?? 0,
        error: entry?.error || server.last?.error || null,
        connectedAt: entry?.connectedAt || server.last?.connectedAt || null,
      };
    });
    return {
      total: servers.length,
      connected: rows.filter((row) => row.state === 'connected').length,
      rows,
    };
  }

  async logs(name, { lines = 80 } = {}) {
    const record = await getServerRecord(name, { dir: this.dir });
    if (!record) throw new McpError(`MCP server ${name} is not configured.`, { code: 'MCP_NOT_CONFIGURED' });
    return readServerLog(name, { dir: this.dir, lines });
  }

  /** Longest-lived resource: close every connection and child process. */
  async close() {
    if (this.closed) return 0;
    this.closed = true;
    let closed = 0;
    const names = [...this.runtime.keys()];
    await Promise.all(
      names.map(async (name) => {
        try {
          await this.disconnect(name, { persist: false });
          closed += 1;
        } catch {
          // Best effort during shutdown.
        }
      }),
    );
    this.runtime.clear();
    return closed;
  }
}

/** Strip anything not safe to show: only key names, never values. */
export function publicRecord(record) {
  return {
    name: record.name,
    transport: record.transport,
    command: record.transport === 'stdio' ? record.command : undefined,
    args: record.transport === 'stdio' ? [...(record.args || [])] : undefined,
    cwd: record.transport === 'stdio' && record.cwd ? record.cwd : undefined,
    url: record.transport === 'http' ? record.url : undefined,
    envKeys: [...(record.envKeys || [])],
    headerNames: [...(record.headerNames || [])],
    auth: { type: record.auth?.type || 'none', ...(record.auth?.header ? { header: record.auth.header } : {}) },
    enabled: Boolean(record.enabled),
    autoConnect: Boolean(record.autoConnect),
    allowPrivateNetwork: Boolean(record.allowPrivateNetwork),
    connectTimeoutMs: record.connectTimeoutMs ?? MCP_DEFAULTS.connectTimeoutMs,
    callTimeoutMs: record.callTimeoutMs ?? MCP_DEFAULTS.callTimeoutMs,
    maxResultBytes: record.maxResultBytes ?? MCP_DEFAULTS.maxResultBytes,
    toolRisk: { ...(record.toolRisk || {}) },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    last: record.last || null,
  };
}

