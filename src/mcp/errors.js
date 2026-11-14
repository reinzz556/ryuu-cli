/**
 * Typed errors for the MCP client layer.
 *
 * Everything the agent/CLI shows about an MCP server goes through this module,
 * so a failure always says which server and phase it came from and whether a
 * retry is worth attempting. Server-provided error text is bounded and never
 * contains credentials (headers/tokens are not part of SDK errors, but the
 * message is clipped anyway).
 */

import { CancelledError, RyuuError } from '../utils/errors.js';

export class McpError extends RyuuError {
  constructor(message, { code = 'MCP_ERROR', details, cause, retryable = false } = {}) {
    super(message, { code, details, cause, retryable });
  }
}

/** A short, single-line version of an arbitrary SDK/transport failure. */
export function briefReason(error, max = 220) {
  const text = String(error?.message || error || 'unknown error')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const STATUS_CODES = /(?:HTTP\s*)?\b(4\d{2}|5\d{2})\b/;

function statusOf(error) {
  const direct = Number(error?.status ?? error?.statusCode ?? error?.code);
  if (Number.isInteger(direct) && direct >= 400 && direct <= 599) return direct;
  const match = String(error?.message || '').match(STATUS_CODES);
  return match ? Number(match[1]) : null;
}

/**
 * Map a failure from the SDK or a transport to a typed error. A cancellation is
 * preserved as CancelledError so the agent loop ends cleanly instead of treating
 * it as a tool failure.
 */
export function mapMcpError(error, { server, phase = 'call' } = {}) {
  if (error instanceof CancelledError) return error;
  if (error?.code === 'CANCELLED' || error?.name === 'AbortError') {
    return new CancelledError('Task cancelled by user.');
  }
  if (error instanceof McpError) {
    return new McpError(error.message, {
      code: error.code,
      details: { server, phase, ...(error.details || {}) },
      cause: error,
      retryable: error.retryable,
    });
  }
  const label = `MCP server ${server || 'unknown'}`;
  const reason = briefReason(error);
  const status = statusOf(error);
  const details = { server, phase, status };

  if (status === 401 || status === 403) {
    return new McpError(
      `${label} rejected the credentials (HTTP ${status}). Run /mcp info ${server || '<name>'} to check the authentication method.`,
      { code: 'MCP_AUTH', details, retryable: false, cause: error },
    );
  }
  if (status === 404) {
    return new McpError(`${label} endpoint was not found (HTTP 404). Check the URL with /mcp info.`, {
      code: 'MCP_NOT_FOUND',
      details,
      cause: error,
    });
  }
  if (status === 429) {
    return new McpError(`${label} is rate limited (HTTP 429). Try again later.`, {
      code: 'MCP_RATE_LIMIT',
      details,
      retryable: true,
      cause: error,
    });
  }
  if (status && status >= 500) {
    return new McpError(`${label} is unavailable (HTTP ${status}).`, {
      code: 'MCP_UPSTREAM',
      details,
      retryable: true,
      cause: error,
    });
  }
  if (/timed? ?out|timeout|deadline/i.test(reason)) {
    return new McpError(`${label} timed out during ${phase}.`, {
      code: 'MCP_TIMEOUT',
      details,
      retryable: true,
      cause: error,
    });
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up|network/i.test(reason)) {
    return new McpError(`${label} cannot be reached during ${phase}: ${reason}`, {
      code: 'MCP_NETWORK',
      details,
      retryable: true,
      cause: error,
    });
  }
  if (/spawn|ENOENT|EACCES|EPERM/i.test(reason)) {
    return new McpError(`${label} could not start (${phase}): ${reason}`, {
      code: 'MCP_SPAWN',
      details,
      cause: error,
    });
  }
  if (error?.code === -32601 || /method not found/i.test(reason)) {
    return new McpError(`${label} does not support this operation (${reason}).`, {
      code: 'MCP_UNSUPPORTED',
      details,
      cause: error,
    });
  }
  if (phase === 'connect') {
    return new McpError(`${label} handshake failed: ${reason}`, {
      code: 'MCP_HANDSHAKE',
      details,
      cause: error,
    });
  }
  if (phase === 'discovery') {
    return new McpError(`${label} capability discovery failed: ${reason}`, {
      code: 'MCP_DISCOVERY',
      details,
      cause: error,
    });
  }
  return new McpError(`${label} call failed during ${phase}: ${reason}`, {
    code: 'MCP_CALL_FAILED',
    details,
    cause: error,
  });
}

/**
 * Race a promise against a hard deadline, an optional AbortSignal and an
 * optional per-request timeout passed to the SDK.
 *
 * The timer is unref'ed so a pending deadline never keeps the CLI alive.
 */
export async function withDeadline(promise, { timeoutMs, signal = null, label = 'operation', server = null } = {}) {
  if (signal?.aborted) throw new CancelledError('Task cancelled by user.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return await promise;
  }
  let timer = null;
  let onAbort = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new McpError(`${server ? `MCP server ${server}: ` : ''}${label} timed out after ${timeoutMs}ms.`, {
          code: 'MCP_TIMEOUT',
          retryable: true,
          details: { server, phase: label },
        }),
      );
    }, timeoutMs);
    timer.unref?.();
    if (signal) {
      onAbort = () => reject(new CancelledError('Task cancelled by user.'));
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
  }
}

/** True when an SDK error means "this server has no such capability". */
export function isUnsupportedMethod(error) {
  const code = error?.code ?? error?.error?.code;
  if (code === -32601) return true;
  return /method not found|not supported|unsupported/i.test(String(error?.message || ''));
}
