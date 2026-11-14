/**
 * Security guards for MCP servers.
 *
 * A server definition is user-supplied configuration, and the tools it exposes
 * are third-party code. The rules here keep both from becoming an escape hatch:
 *
 *  - a stdio server is spawned directly (never through a shell) from a resolved
 *    executable path, with a minimal environment;
 *  - HTTP endpoints go through the same SSRF guard as `read_url`, plus an
 *    explicit per-server opt-in for local/private addresses;
 *  - headers are validated so a value cannot inject a second header;
 *  - every payload is bounded before it reaches the model.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { safeChildEnv } from '../services/websearch/mcp.js';
import { assertPublicUrl } from '../utils/network.js';
import { McpError } from './errors.js';

const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,80}$/;
const MAX_ARG_CHARS = 4096;
const MAX_ARG_COUNT = 64;
const MAX_SECRET_CHARS = 16 * 1024;

/** Strip control characters a terminal would choke on, and bound the length. */
export function cleanText(value, max = 4096) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, max);
}

/**
 * Resolve a stdio command to an executable path.
 *
 * A command containing a path separator is resolved against `cwd` (when
 * relative) and must exist. A bare name is looked up on PATH, exactly like a
 * shell would, but the result is spawned without a shell so arguments can never
 * be reinterpreted as commands.
 */
export async function resolveExecutable(command, { cwd = process.cwd(), env = process.env, platform = process.platform } = {}) {
  const raw = String(command ?? '').trim();
  if (!raw) throw new McpError('A stdio MCP server needs a command.', { code: 'MCP_COMMAND_INVALID' });
  if (raw.includes('\u0000')) throw new McpError('The MCP command contains a NUL byte.', { code: 'MCP_COMMAND_INVALID' });
  if (/[\r\n]/.test(raw)) throw new McpError('The MCP command must be a single line.', { code: 'MCP_COMMAND_INVALID' });

  const isWindows = platform === 'win32';
  const hasSeparator = raw.includes('/') || (isWindows && raw.includes('\\'));
  const candidates = [];
  if (hasSeparator) {
    candidates.push(path.isAbsolute(raw) ? raw : path.resolve(cwd, raw));
  } else {
    const pathValue = String(env.PATH ?? env.Path ?? '');
    const dirs = pathValue.split(isWindows ? ';' : ':').filter(Boolean);
    const extensions = isWindows
      ? String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];
    for (const dir of dirs) {
      for (const extension of extensions) {
        candidates.push(path.join(dir, `${raw}${extension}`));
      }
    }
  }

  for (const candidate of candidates) {
    try {
      const stats = await fsp.stat(candidate);
      if (!stats.isFile()) continue;
      await fsp.access(candidate, isWindows ? fsp.constants.F_OK : fsp.constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new McpError(
    `MCP command not found or not executable: ${JSON.stringify(raw)}. Use an absolute path or a command on PATH.`,
    { code: 'MCP_EXEC_NOT_FOUND', details: { command: raw } },
  );
}

/** Validate the argument array accepted by a stdio server. */
export function validateArgs(args = []) {
  if (args === undefined || args === null) return [];
  if (!Array.isArray(args)) throw new McpError('MCP command arguments must be an array of strings.', { code: 'MCP_ARGS_INVALID' });
  if (args.length > MAX_ARG_COUNT) {
    throw new McpError(`At most ${MAX_ARG_COUNT} MCP command arguments are allowed.`, { code: 'MCP_ARGS_INVALID' });
  }
  return args.map((arg, index) => {
    const text = String(arg ?? '');
    if (text.includes('\u0000')) {
      throw new McpError(`MCP argument #${index + 1} contains a NUL byte.`, { code: 'MCP_ARGS_INVALID' });
    }
    if (text.length > MAX_ARG_CHARS) {
      throw new McpError(`MCP argument #${index + 1} exceeds ${MAX_ARG_CHARS} characters.`, { code: 'MCP_ARGS_INVALID' });
    }
    return text;
  });
}

/**
 * Environment for a spawned MCP server: the safe baseline plus the values the
 * user explicitly configured for this server. Ryuu's own credentials are never
 * inherited (`RYUU_*`, provider keys), even if they exist in the parent process.
 */
export function buildChildEnv(extra = {}) {
  const env = safeChildEnv({});
  for (const [key, value] of Object.entries(extra || {})) {
    if (typeof value !== 'string') continue;
    if (value.length > MAX_SECRET_CHARS) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Validate an HTTP MCP endpoint.
 *
 * @param {string} url
 * @param {object} options
 * @param {boolean} [options.allowPrivate] explicit opt-in for localhost/LAN
 * @param {boolean} [options.resolve] resolve DNS and check every address
 */
export async function validateHttpUrl(url, { allowPrivate = false, resolve = false } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ''));
  } catch {
    throw new McpError(`MCP server URL is not valid: ${JSON.stringify(url)}`, { code: 'MCP_URL_INVALID' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new McpError('MCP server URL must use http:// or https://.', { code: 'MCP_URL_INVALID' });
  }
  if (parsed.username || parsed.password) {
    throw new McpError('MCP server URL must not embed credentials; use auth or headers instead.', { code: 'MCP_URL_INVALID' });
  }
  if (!allowPrivate) {
    await assertPublicUrl(parsed, { resolve }).catch((error) => {
      throw new McpError(
        `${error.message} Set allowPrivateNetwork only if this MCP server really runs on your machine or LAN.`,
        { code: 'MCP_URL_BLOCKED', cause: error },
      );
    });
  }
  return parsed;
}

/** Validate configured headers and refuse CR/LF injection. */
export function sanitizeHeaders(headers = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (!HEADER_NAME_PATTERN.test(name)) {
      throw new McpError(`Invalid HTTP header name in MCP config: ${JSON.stringify(name)}`, { code: 'MCP_HEADER_INVALID' });
    }
    const text = String(value ?? '');
    if (/[\r\n]/.test(text)) {
      throw new McpError(`HTTP header ${name} contains a line break; refusing to send it.`, { code: 'MCP_HEADER_INVALID' });
    }
    if (text.length > MAX_SECRET_CHARS) {
      throw new McpError(`HTTP header ${name} is too long.`, { code: 'MCP_HEADER_INVALID' });
    }
    out[name] = text;
  }
  return out;
}

/** Build the headers for a bearer-token server (token stays in this function). */
export function bearerHeaders(auth = {}, token = '') {
  if (!token) return {};
  const header = String(auth.header || 'Authorization');
  const value = header.toLowerCase() === 'authorization' && !/^bearer\s/i.test(token) ? `Bearer ${token}` : token;
  return sanitizeHeaders({ [header]: value });
}

/** Bound an arbitrary text payload. */
export function truncateText(value, maxBytes = 256 * 1024) {
  const text = String(value ?? '');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  const buffer = Buffer.from(text, 'utf8').subarray(0, maxBytes);
  // Do not return a half-written UTF-8 sequence.
  return { text: buffer.toString('utf8').replace(/\uFFFD$/, ''), truncated: true };
}
