/**
 * Persistence for MCP servers.
 *
 * Layout (inside Ryuu's existing config directory):
 *   <config>/mcp/servers.json            server definitions, no secrets
 *   <config>/mcp/credentials/<name>.json tokens, env values and headers (0600)
 *   <config>/mcp/logs/<name>.log          redacted connection/tool log
 *
 * Secrets are split out on purpose: `servers.json` is safe to show, back up or
 * paste into an issue, while the credentials file is owner-only and never
 * printed by any command. Every write is atomic (temp file + rename) and refuses
 * to follow a symlink, matching how config.json is handled.
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { settingsDir } from '../config/settings.js';
import { McpError } from './errors.js';

export const MCP_STORE_VERSION = 1;
export const MAX_MCP_SERVERS = 32;
export const SERVER_NAME_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:/ -]{1,128}$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,80}$/;
const TRANSPORTS = new Set(['stdio', 'http']);
const AUTH_TYPES = new Set(['none', 'bearer', 'oauth']);
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;
const MAX_RESULT_BYTES_LIMIT = 4 * 1024 * 1024;

function mcpError(message, code, details = undefined) {
  return new McpError(message, { code, details });
}

/** Root of the MCP state. `dir` allows tests (and embedders) to override it. */
export function mcpRoot(dir = null) {
  return dir ? path.resolve(dir) : path.join(settingsDir(), 'mcp');
}

export function serversFile(dir = null) {
  return path.join(mcpRoot(dir), 'servers.json');
}

export function credentialsDir(dir = null) {
  return path.join(mcpRoot(dir), 'credentials');
}

export function credentialsFile(name, dir = null) {
  assertServerName(name);
  return path.join(credentialsDir(dir), `${name}.json`);
}

export function logsDir(dir = null) {
  return path.join(mcpRoot(dir), 'logs');
}

export function logFile(name, dir = null) {
  assertServerName(name);
  return path.join(logsDir(dir), `${name}.log`);
}

export function assertServerName(name) {
  const value = String(name ?? '');
  if (!SERVER_NAME_PATTERN.test(value)) {
    throw mcpError(
      `Invalid MCP server name ${JSON.stringify(name)}. Use 2-32 lowercase letters, digits, "_" or "-", starting with a letter.`,
      'MCP_NAME_INVALID',
    );
  }
  return value;
}

async function assertNotSymlink(file) {
  try {
    const stats = await fsp.lstat(file);
    if (stats.isSymbolicLink()) {
      throw mcpError(`Refusing to use ${file} through a symlink. Replace it with a regular file.`, 'MCP_PATH_SYMLINK');
    }
  } catch (error) {
    if (error.code === 'ENOENT') return;
    if (error instanceof McpError) throw error;
    throw mcpError(`Cannot inspect ${file}: ${error.message}`, 'MCP_PATH_UNREADABLE');
  }
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fsp.chmod(dir, 0o700).catch(() => {});
}

/** Atomic owner-only JSON write. */
async function writeJsonPrivate(file, data) {
  const dir = path.dirname(file);
  await ensureDir(dir);
  await assertNotSymlink(file);
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`);
  let handle = null;
  let json;
  try {
    json = `${JSON.stringify(data, null, 2)}\n`;
  } catch (error) {
    throw mcpError(`MCP data cannot be serialized: ${error.message}`, 'MCP_STORE_INVALID');
  }
  try {
    handle = await fsp.open(temp, 'wx', 0o600);
    await handle.writeFile(json, 'utf8');
    await handle.sync().catch((error) => {
      if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error;
    });
    await handle.close();
    handle = null;
    await fsp.rename(temp, file);
    if (process.platform !== 'win32') await fsp.chmod(file, 0o600).catch(() => {});
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw mcpError(`Cannot write ${file}: ${error.message}`, 'MCP_STORE_WRITE_FAILED', { file });
  }
}

function emptyStore() {
  return { version: MCP_STORE_VERSION, servers: {} };
}

/**
 * Serialize read-modify-write operations per store directory.
 *
 * Without this, two servers connecting in parallel could each read the store,
 * then write it back and lose the other's `last` state. The chain is per
 * directory and never rejects (a failed write must not poison later writes).
 */
const storeWriteChains = new Map();

async function withStoreLock(dir, task) {
  const key = mcpRoot(dir);
  const previous = storeWriteChains.get(key) || Promise.resolve();
  const run = previous.then(task, task);
  storeWriteChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

function normalizeStore(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return emptyStore();
  const servers = data.servers && typeof data.servers === 'object' && !Array.isArray(data.servers) ? data.servers : {};
  return { version: MCP_STORE_VERSION, servers };
}

/**
 * Read `servers.json`.
 *
 * A missing file is an empty store. A malformed file is an error, never
 * silently replaced: it holds the user's whole MCP setup.
 */
export async function readStore({ dir = null } = {}) {
  const file = serversFile(dir);
  await assertNotSymlink(file);
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyStore();
    throw mcpError(`Cannot read ${file}: ${error.message}`, 'MCP_STORE_UNREADABLE', { file });
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw mcpError(
      `MCP config ${file} is not valid JSON (${error.message}). It was NOT modified: fix it or move it aside.`,
      'MCP_STORE_INVALID',
      { file },
    );
  }
  const store = normalizeStore(data);
  // Drop entries whose name no longer matches the pattern instead of failing
  // every command because of one hand-edited key.
  for (const [name, server] of Object.entries(store.servers)) {
    if (!SERVER_NAME_PATTERN.test(name) || !server || typeof server !== 'object') delete store.servers[name];
    else server.name = name;
  }
  return store;
}

async function writeStore(store, { dir = null } = {}) {
  const normalized = normalizeStore(store);
  await writeJsonPrivate(serversFile(dir), normalized);
  return normalized;
}

export async function listServers({ dir = null } = {}) {
  const store = await readStore({ dir });
  return Object.values(store.servers).sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

export async function getServerRecord(name, { dir = null } = {}) {
  const key = assertServerName(name);
  const store = await readStore({ dir });
  return store.servers[key] || null;
}

function boundedInt(value, { fallback, min, max, label }) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw mcpError(`${label} must be an integer between ${min} and ${max}.`, 'MCP_CONFIG_INVALID');
  }
  return number;
}

function stringList(value, { label, pattern, max = 128 } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw mcpError(`${label} must be an array.`, 'MCP_CONFIG_INVALID');
  if (value.length > max) throw mcpError(`${label} may contain at most ${max} entries.`, 'MCP_CONFIG_INVALID');
  return value.map((entry) => {
    const text = String(entry ?? '');
    if (!text || text.includes('\u0000')) {
      throw mcpError(`${label} contains an empty or invalid entry.`, 'MCP_CONFIG_INVALID');
    }
    if (pattern && !pattern.test(text)) {
      throw mcpError(`${label} entry ${JSON.stringify(text)} is not valid.`, 'MCP_CONFIG_INVALID');
    }
    return text;
  });
}

function stringMap(value, { label, keyPattern, maxEntries = 64 } = {}) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw mcpError(`${label} must be an object.`, 'MCP_CONFIG_INVALID');
  }
  const entries = Object.entries(value);
  if (entries.length > maxEntries) {
    throw mcpError(`${label} may contain at most ${maxEntries} entries.`, 'MCP_CONFIG_INVALID');
  }
  const out = {};
  for (const [key, raw] of entries) {
    if (!keyPattern.test(key)) {
      throw mcpError(`${label} key ${JSON.stringify(key)} is not valid.`, 'MCP_CONFIG_INVALID');
    }
    if (typeof raw !== 'string' || raw.includes('\u0000')) {
      throw mcpError(`${label}.${key} must be a string without NUL bytes.`, 'MCP_CONFIG_INVALID');
    }
    out[key] = raw;
  }
  return out;
}

/**
 * Split user input into the persisted (secret-free) server record and the
 * secrets that belong in the private credentials file.
 */
export function splitServerInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw mcpError('MCP server configuration must be an object.', 'MCP_CONFIG_INVALID');
  }
  const name = assertServerName(String(input.name ?? '').trim().toLowerCase());
  const transport = String(input.transport ?? 'stdio').toLowerCase();
  if (!TRANSPORTS.has(transport)) {
    throw mcpError(`Transport must be "stdio" or "http" (received ${JSON.stringify(input.transport)}).`, 'MCP_CONFIG_INVALID');
  }
  const env = stringMap(input.env, { label: 'env', keyPattern: ENV_KEY_PATTERN });
  const headers = stringMap(input.headers, { label: 'headers', keyPattern: HEADER_NAME_PATTERN, maxEntries: 32 });
  for (const [header, value] of Object.entries(headers)) {
    if (/[\r\n]/.test(value)) {
      throw mcpError(`Header ${header} contains a line break; refusing to store it.`, 'MCP_HEADER_INVALID');
    }
  }
  const envKeys = Array.isArray(input.envKeys)
    ? stringList(input.envKeys, { label: 'envKeys', pattern: ENV_KEY_PATTERN })
    : Object.keys(env);
  const headerNames = Array.isArray(input.headerNames)
    ? stringList(input.headerNames, { label: 'headerNames', pattern: HEADER_NAME_PATTERN })
    : Object.keys(headers);

  const authInput = input.auth && typeof input.auth === 'object' ? input.auth : {};
  const authType = String(authInput.type ?? 'none').toLowerCase();
  if (!AUTH_TYPES.has(authType)) {
    throw mcpError(`auth.type must be none, bearer or oauth (received ${JSON.stringify(authInput.type)}).`, 'MCP_CONFIG_INVALID');
  }
  const authHeader = String(authInput.header ?? 'Authorization');
  if (authType === 'bearer' && !HEADER_NAME_PATTERN.test(authHeader)) {
    throw mcpError(`auth.header ${JSON.stringify(authHeader)} is not a valid HTTP header name.`, 'MCP_CONFIG_INVALID');
  }

  const now = new Date().toISOString();
  const record = {
    name,
    transport,
    command: transport === 'stdio' ? String(input.command ?? '').trim() : '',
    args: transport === 'stdio' ? stringList(input.args, { label: 'args', max: 64 }) : [],
    cwd: transport === 'stdio' && input.cwd ? String(input.cwd) : '',
    envKeys,
    url: transport === 'http' ? String(input.url ?? '').trim() : '',
    headerNames,
    auth: authType === 'none' ? { type: 'none' } : { type: authType, header: authType === 'bearer' ? authHeader : 'Authorization' },
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    autoConnect: input.autoConnect === undefined ? true : Boolean(input.autoConnect),
    allowPrivateNetwork: Boolean(input.allowPrivateNetwork),
    connectTimeoutMs: boundedInt(input.connectTimeoutMs, {
      fallback: DEFAULT_CONNECT_TIMEOUT_MS,
      min: 1000,
      max: 120_000,
      label: 'connectTimeoutMs',
    }),
    callTimeoutMs: boundedInt(input.callTimeoutMs, {
      fallback: DEFAULT_CALL_TIMEOUT_MS,
      min: 1000,
      max: 300_000,
      label: 'callTimeoutMs',
    }),
    maxResultBytes: boundedInt(input.maxResultBytes, {
      fallback: DEFAULT_MAX_RESULT_BYTES,
      min: 1024,
      max: MAX_RESULT_BYTES_LIMIT,
      label: 'maxResultBytes',
    }),
    // Per-tool risk overrides: { "create_issue": "destructive", ... }.
    toolRisk:
      input.toolRisk && typeof input.toolRisk === 'object' && !Array.isArray(input.toolRisk)
        ? Object.fromEntries(
            Object.entries(input.toolRisk)
              .filter(([, risk]) => ['read', 'write', 'exec', 'destructive'].includes(String(risk)))
              .map(([tool, risk]) => [String(tool).slice(0, 128), String(risk)]),
          )
        : {},
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : now,
    updatedAt: now,
    last: input.last && typeof input.last === 'object' ? input.last : { state: 'disconnected' },
  };

  if (transport === 'stdio') {
    if (!record.command) throw mcpError('A stdio MCP server needs a command.', 'MCP_CONFIG_INVALID');
    if (record.command.includes('\u0000')) throw mcpError('The command contains a NUL byte.', 'MCP_COMMAND_INVALID');
  } else {
    let parsed;
    try {
      parsed = new URL(record.url);
    } catch {
      throw mcpError(`MCP server URL is not valid: ${JSON.stringify(record.url)}`, 'MCP_URL_INVALID');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw mcpError('MCP server URL must use http:// or https://.', 'MCP_URL_INVALID');
    }
    if (parsed.username || parsed.password) {
      throw mcpError('MCP server URL must not embed credentials; use auth or headers instead.', 'MCP_URL_INVALID');
    }
  }

  const secrets = {};
  if (Object.keys(env).length > 0) secrets.env = env;
  if (Object.keys(headers).length > 0) secrets.headers = headers;
  if (typeof input.token === 'string' && input.token.trim()) secrets.token = input.token.trim();
  if (input.oauth && typeof input.oauth === 'object') secrets.oauth = input.oauth;
  return { record, secrets };
}

/** Insert or update one server. Secrets are written separately. */
export async function upsertServer(input, { dir = null } = {}) {
  const { record, secrets } = splitServerInput(input);
  return withStoreLock(dir, async () => {
  const store = await readStore({ dir });
  if (!store.servers[record.name] && Object.keys(store.servers).length >= MAX_MCP_SERVERS) {
    throw mcpError(`At most ${MAX_MCP_SERVERS} MCP servers can be stored. Remove one with /mcp remove <name>.`, 'MCP_LIMIT');
  }
  if (store.servers[record.name]) record.createdAt = store.servers[record.name].createdAt || record.createdAt;
  // A secret-free edit (enable/disable) must not erase stored credentials.
  if (input.keepSecrets !== false) await writeSecrets(record.name, secrets, { dir, merge: Boolean(store.servers[record.name]) });
  store.servers[record.name] = record;
  await writeStore(store, { dir });
  return record;
  });
}

async function writeSecrets(name, secrets, { dir = null, merge = false } = {}) {
  const file = credentialsFile(name, dir);
  let current = {};
  if (merge) current = await readSecrets(name, { dir }).catch(() => ({}));
  const next = { ...current, ...secrets };
  // Empty maps are removed so a cleared secret does not linger.
  if (secrets.env && Object.keys(secrets.env).length === 0) delete next.env;
  if (secrets.headers && Object.keys(secrets.headers).length === 0) delete next.headers;
  if (secrets.token === '') delete next.token;
  if (Object.keys(next).length === 0) {
    await fsp.rm(file, { force: true }).catch(() => {});
    return {};
  }
  await writeJsonPrivate(file, next);
  return next;
}

/** Private credentials for one server. Never returned to the model or logs. */
export async function readSecrets(name, { dir = null } = {}) {
  const file = credentialsFile(name, dir);
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw mcpError(`Cannot read MCP credentials for ${name}: ${error.message}`, 'MCP_CREDENTIALS_UNREADABLE');
  }
  try {
    const data = JSON.parse(text);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    throw mcpError(
      `MCP credentials file for ${name} is not valid JSON. It was NOT modified.`,
      'MCP_CREDENTIALS_INVALID',
    );
  }
}

export async function writeServerSecrets(name, secrets, { dir = null, merge = true } = {}) {
  assertServerName(name);
  return writeSecrets(name, secrets, { dir, merge });
}

export async function removeServer(name, { dir = null } = {}) {
  const key = assertServerName(name);
  return withStoreLock(dir, async () => {
  const store = await readStore({ dir });
  const existing = store.servers[key];
  if (!existing) return null;
  delete store.servers[key];
  await writeStore(store, { dir });
  await fsp.rm(credentialsFile(key, dir), { force: true }).catch(() => {});
  await fsp.rm(logFile(key, dir), { force: true }).catch(() => {});
  return existing;
  });
}

export async function setServerEnabled(name, enabled, { dir = null } = {}) {
  const key = assertServerName(name);
  return withStoreLock(dir, async () => {
  const store = await readStore({ dir });
  const record = store.servers[key];
  if (!record) throw mcpError(`MCP server ${key} is not configured.`, 'MCP_NOT_CONFIGURED');
  record.enabled = Boolean(enabled);
  record.updatedAt = new Date().toISOString();
  await writeStore(store, { dir });
  return record;
  });
}

/** Persist the last connection outcome (never a secret). */
export async function recordServerState(name, patch = {}, { dir = null } = {}) {
  const key = assertServerName(name);
  return withStoreLock(dir, async () => {
  const store = await readStore({ dir });
  const record = store.servers[key];
  if (!record) return null;
  record.last = {
    ...(record.last || {}),
    ...patch,
    at: new Date().toISOString(),
  };
  // Keep the file bounded: a long error message is clipped.
  if (typeof record.last.error === 'string') record.last.error = record.last.error.slice(0, 300);
  await writeStore(store, { dir });
  return record;
  });
}

/** Append one redacted line to the server log, rotating at a fixed size. */
export async function appendServerLog(name, line, { dir = null, maxBytes = 512 * 1024 } = {}) {
  const key = assertServerName(name);
  const file = logFile(key, dir);
  await ensureDir(logsDir(dir));
  await assertNotSymlink(file);
  const text = `${new Date().toISOString()} ${String(line).replace(/\s+$/g, '')}\n`;
  try {
    const stats = await fsp.stat(file).catch(() => null);
    if (stats && stats.size > maxBytes) {
      const handle = await fsp.open(file, 'r');
      const start = Math.max(0, stats.size - Math.floor(maxBytes / 2));
      const buffer = Buffer.alloc(stats.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      await handle.close();
      await fsp.writeFile(file, buffer, { mode: 0o600 });
    }
    await fsp.appendFile(file, text, { mode: 0o600 });
    if (process.platform !== 'win32') await fsp.chmod(file, 0o600).catch(() => {});
  } catch {
    // Logging must never take the CLI down.
  }
}

/** Last `lines` lines of a server log (already redacted when written). */
export async function readServerLog(name, { dir = null, lines = 80 } = {}) {
  const file = logFile(name, dir);
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { file, text: '', lines: [] };
    throw mcpError(`Cannot read the MCP log for ${name}: ${error.message}`, 'MCP_LOG_UNREADABLE');
  }
  const all = text.split('\n').filter(Boolean);
  return { file, text: all.slice(-Math.max(1, Math.min(lines, 1000))).join('\n'), lines: all };
}

export const MCP_DEFAULTS = Object.freeze({
  connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
  callTimeoutMs: DEFAULT_CALL_TIMEOUT_MS,
  maxResultBytes: DEFAULT_MAX_RESULT_BYTES,
});
