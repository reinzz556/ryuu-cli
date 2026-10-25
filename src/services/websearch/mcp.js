/**
 * Minimal MCP client wrapper.
 *
 * Remote providers use Streamable HTTP; the DuckDuckGo option uses stdio. The
 * SDK handles protocol details, while this module adds the operational rules the
 * agent needs: a hard timeout per operation, sanitized child-process
 * environments, and typed errors that say whether a retry is worth it.
 *
 * Secrets never enter this module's logs: HTTP credentials travel in headers,
 * and the stdio server receives a minimal environment (PATH/HOME only), not the
 * agent's NVIDIA key or other credentials.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CancelledError, SearchError } from '../../utils/errors.js';
import { readVersion } from '../../utils/version.js';

const CLIENT_INFO = { name: 'ryuu-agent-cli', version: readVersion() };

const SAFE_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'SystemRoot',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
];

/** Environment for a third-party stdio server: no API keys, no session secrets. */
export function safeChildEnv(extra = {}) {
  const env = {};
  for (const key of SAFE_ENV_KEYS) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(extra || {})) {
    if (/^(NVIDIA|OPENAI|ANTHROPIC|TAVILY|FIRECRAWL|YDC|YOU|SERPER|SEARCH)_/i.test(key)) continue;
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

function statusOf(error) {
  const direct = Number(error?.status ?? error?.code);
  if (Number.isInteger(direct) && direct >= 400 && direct <= 599) return direct;
  const match = String(error?.message || '').match(/\b(4\d{2}|5\d{2})\b/);
  return match ? Number(match[1]) : null;
}

/** Map an SDK/transport failure to a typed, actionable error. */
export function mcpError(error, { provider, phase }) {
  if (error?.code === 'CANCELLED' || error?.name === 'AbortError') {
    return new CancelledError('Task cancelled by user.');
  }
  const status = statusOf(error);
  const label = provider?.label || provider?.id || 'MCP provider';
  const reason = String(error?.message || error).replace(/\s+/g, ' ').slice(0, 200);
  if (status === 401 || status === 403) {
    return new SearchError(`${label} rejected the credentials (HTTP ${status}).`, {
      code: 'MCP_AUTH',
      status,
      details: { provider: provider?.id, phase },
    });
  }
  if (status === 429) {
    return new SearchError(`${label} is rate limited (HTTP 429).`, {
      code: 'MCP_RATE_LIMIT',
      status,
      retryable: true,
      details: { provider: provider?.id, phase },
    });
  }
  if (status >= 500) {
    return new SearchError(`${label} is unavailable (HTTP ${status}).`, {
      code: 'MCP_UPSTREAM',
      status,
      retryable: true,
      details: { provider: provider?.id, phase },
    });
  }
  if (/timeout|timed out|aborted/i.test(reason)) {
    return new SearchError(`${label} timed out during ${phase}.`, {
      code: 'MCP_TIMEOUT',
      retryable: true,
      details: { provider: provider?.id, phase },
    });
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket/i.test(reason)) {
    return new SearchError(`${label} cannot be reached: ${reason}`, {
      code: 'MCP_NETWORK',
      retryable: true,
      details: { provider: provider?.id, phase },
    });
  }
  if (/spawn|ENOENT/i.test(reason)) {
    return new SearchError(`${label} could not start: ${reason}`, {
      code: 'MCP_SPAWN',
      details: { provider: provider?.id, phase },
    });
  }
  if (phase === 'handshake') {
    return new SearchError(`${label} MCP handshake failed: ${reason}`, {
      code: 'MCP_HANDSHAKE',
      details: { provider: provider?.id, phase },
    });
  }
  if (phase === 'discovery') {
    return new SearchError(`${label} tool discovery failed: ${reason}`, {
      code: 'MCP_DISCOVERY',
      details: { provider: provider?.id, phase },
    });
  }
  return new SearchError(`${label} call failed: ${reason}`, {
    code: 'MCP_CALL_FAILED',
    details: { provider: provider?.id, phase },
  });
}

/** Race a promise against a hard deadline and an optional abort signal. */
export async function withTimeout(promise, { timeoutMs, signal = null, label = 'operation' }) {
  if (signal?.aborted) throw new CancelledError('Task cancelled by user.');
  let timer;
  let onAbort;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new SearchError(`${label} timed out after ${timeoutMs}ms.`, { code: 'MCP_TIMEOUT', retryable: true }));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    if (signal) {
      onAbort = () => reject(new CancelledError('Task cancelled by user.'));
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Open one MCP connection and discover its tools.
 *
 * @param {object} provider provider descriptor
 * @param {object} options
 * @param {number} options.timeoutMs
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{client: object, tools: object[]}>}
 */
export async function connectProvider(provider, { timeoutMs = 8000, signal = null, logger = null } = {}) {
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  let transport;
  try {
    if (provider.transport === 'stdio') {
      transport = new StdioClientTransport({
        command: provider.command,
        args: provider.args || [],
        env: safeChildEnv(provider.env),
        cwd: provider.cwd || process.cwd(),
        stderr: 'pipe',
      });
    } else {
      transport = new StreamableHTTPClientTransport(new URL(provider.url), {
        requestInit: { headers: provider.headers || {} },
      });
    }
    await withTimeout(client.connect(transport), {
      timeoutMs,
      signal,
      label: `${provider.label} handshake`,
    });
  } catch (error) {
    await closeQuietly(client, transport);
    throw mcpError(error, { provider, phase: 'handshake' });
  }

  try {
    const listed = await withTimeout(client.listTools(undefined, { timeout: timeoutMs }), {
      timeoutMs,
      signal,
      label: `${provider.label} tool discovery`,
    });
    const tools = Array.isArray(listed?.tools) ? listed.tools : [];
    logger?.debug('mcp provider discovered', {
      provider: provider.id,
      tools: tools.map((tool) => tool.name).slice(0, 20),
    });
    return { client, tools };
  } catch (error) {
    await closeQuietly(client, transport);
    throw mcpError(error, { provider, phase: 'discovery' });
  }
}

/**
 * Call one discovered tool. The SDK validates the result envelope; the caller
 * normalizes the payload.
 */
export async function callTool(connection, { name, args, timeoutMs = 8000, signal = null }) {
  return withTimeout(
    connection.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs, signal }),
    { timeoutMs, signal, label: `${name}` },
  );
}

async function closeQuietly(client, transport) {
  try {
    if (typeof client?.close === 'function') await client.close();
    else if (typeof transport?.close === 'function') await transport.close();
  } catch {
    // Closing a broken transport is best-effort.
  }
}

export async function closeConnection(connection) {
  if (!connection) return;
  try {
    if (typeof connection.client?.close === 'function') await connection.client.close();
    else if (typeof connection.transport?.close === 'function') await connection.transport.close();
  } catch {
    // best-effort
  }
}
