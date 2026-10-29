import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RyuuError } from '../utils/errors.js';
import { buildProviders, normalizeModelId, normalizeProviderId, parseExtraProviders } from '../providers/catalog.js';

/**
 * Global user settings.
 *
 * Unlike `.env` (per project, per shell) and `.ryuu/preferences.json` (per
 * workspace), this file belongs to the user: it is found from any working
 * directory, holds the provider credentials and the agent defaults, and is
 * edited with `ryuu --settings`.
 *
 * Shape (every section optional; unknown keys are preserved):
 *   {
 *     "version": 1,
 *     "provider": "nvidia",
 *     "providerModel": { "nvidia": "…" },
 *     "providers": { "nvidia": { "apiKey": "", "baseURL": "…" } },
 *     "agent": { "maxSteps": 0, "approvalPolicy": "ask" },
 *     "webSearch": { "serperApiKey": "", "providers": ["you", "firecrawl"] }
 *   }
 *
 * The file may contain credentials, so it is written atomically with owner-only
 * permissions and is never read or written through a symlink.
 */

export const SETTINGS_VERSION = 1;
export const SETTINGS_FILE_NAME = 'config.json';
export const SETTINGS_DIR_ENV = 'RYUU_CONFIG_DIR';

/** Agent keys mirrored from the settings file into the raw config. */
export const AGENT_SETTING_KEYS = [
  'maxSteps',
  'maxOutputTokens',
  'requestTimeoutMs',
  'streamIdleTimeoutMs',
  'maxRetries',
  'maxRecoveryAttempts',
  'recoveryBackoffMs',
  'maxFileBytes',
  'maxSearchResults',
  'maxToolOutputBytes',
  'maxTaskDurationMs',
  'maxContextChars',
  'approvalPolicy',
  'logLevel',
];

/** `webSearch` settings keys and the raw-config key each one fills. */
export const WEB_SETTING_KEYS = {
  serperApiKey: 'webSearchApiKey',
  youApiKey: 'youApiKey',
  firecrawlApiKey: 'firecrawlApiKey',
  tavilyApiKey: 'tavilyApiKey',
  results: 'webSearchResults',
  timeoutMs: 'webSearchTimeoutMs',
  providers: 'webSearchProviders',
};

const BLOCKED_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const SECTIONS = ['providers', 'agent', 'webSearch', 'providerModel'];

function settingsError(message, { cause = null, file = null } = {}) {
  return new RyuuError(message, {
    code: 'SETTINGS_INVALID',
    cause,
    details: file ? { file } : undefined,
  });
}

/**
 * The platform's standard per-user configuration directory.
 *
 * `RYUU_CONFIG_DIR` overrides it (used by tests and by anyone who keeps their
 * config elsewhere). Windows: %APPDATA%\ryuu, macOS: ~/Library/Application
 * Support/ryuu, Linux/BSD: $XDG_CONFIG_HOME/ryuu or ~/.config/ryuu.
 */
export function settingsDir({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const override = env[SETTINGS_DIR_ENV];
  if (typeof override === 'string' && override.trim()) return path.resolve(override.trim());
  if (platform === 'win32') {
    const appData = env.APPDATA ? String(env.APPDATA) : path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'ryuu');
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'ryuu');
  const xdg = typeof env.XDG_CONFIG_HOME === 'string' ? env.XDG_CONFIG_HOME.trim() : '';
  return path.join(xdg ? path.resolve(xdg) : path.join(home, '.config'), 'ryuu');
}

/** Full path of the settings file. */
export function settingsFile(options = {}) {
  return path.join(settingsDir(options), SETTINGS_FILE_NAME);
}

/** Refuse to read or replace a path that is a symlink. */
async function assertNotSymlink(file) {
  try {
    const stats = await fsp.lstat(file);
    if (stats.isSymbolicLink()) {
      throw settingsError(
        `Refusing to use the settings file through a symlink: ${file}. Replace it with a regular file.`,
        { file },
      );
    }
  } catch (error) {
    if (error.code === 'ENOENT') return;
    if (error instanceof RyuuError) throw error;
    throw settingsError(`Cannot inspect the settings file ${file}: ${error.message}`, { cause: error, file });
  }
}

function assertSections(data, file) {
  for (const section of SECTIONS) {
    const value = data[section];
    if (value === undefined) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw settingsError(
        `Settings file ${file} has an invalid "${section}" section (expected an object). It was NOT modified.`,
        { file },
      );
    }
  }
}

/** Read the settings file. Missing is not an error; malformed is. */
export async function readSettings({ file = null, ...options } = {}) {
  const target = file || settingsFile(options);
  await assertNotSymlink(target);
  let text;
  try {
    text = await fsp.readFile(target, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { file: target, exists: false, data: { version: SETTINGS_VERSION } };
    }
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      throw settingsError(
        `Permission denied reading settings ${target}. Fix the file permissions or set ${SETTINGS_DIR_ENV}.`,
        { cause: error, file: target },
      );
    }
    if (error.code === 'EISDIR') {
      throw settingsError(`Settings path is a directory, not a file: ${target}`, { file: target });
    }
    throw settingsError(`Cannot read settings ${target}: ${error.message}`, { cause: error, file: target });
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw settingsError(
      `Settings file ${target} is not valid JSON (${error.message}). It was NOT modified: fix it or move it aside before running --settings.`,
      { cause: error, file: target },
    );
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw settingsError(`Settings file ${target} must contain a JSON object. It was NOT modified.`, {
      file: target,
    });
  }
  assertSections(data, target);
  return { file: target, exists: true, data };
}

/** A JSON-only deep copy, so a draft never mutates the loaded object. */
export function cloneSettings(data) {
  return JSON.parse(JSON.stringify(data ?? {}));
}

function segmentsOf(key) {
  const segments = String(key ?? '').split('.');
  if (segments.length === 0 || segments.some((segment) => !segment || BLOCKED_SEGMENTS.has(segment))) {
    throw new Error(`Invalid settings key: ${JSON.stringify(key)}`);
  }
  return segments;
}

/** Read a dotted settings key; undefined when absent. */
export function getSetting(data, key) {
  let cursor = data;
  for (const segment of segmentsOf(key)) {
    if (!cursor || typeof cursor !== 'object' || !(segment in cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

/** Write a dotted settings key into `data` (mutates it and returns it). */
export function setSetting(data, key, value) {
  const segments = segmentsOf(key);
  let cursor = data;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (!next || typeof next !== 'object' || Array.isArray(next)) cursor[segment] = {};
    cursor = cursor[segment];
  }
  cursor[segments[segments.length - 1]] = value;
  return data;
}

/**
 * Write the settings atomically: a temp file in the same directory, fsync,
 * rename over the target, then owner-only permissions. A crash can never leave
 * a half-written config.json behind.
 */
export async function writeSettings(data, { file = null, ...options } = {}) {
  const target = file || settingsFile(options);
  const dir = path.dirname(target);
  let json;
  try {
    json = `${JSON.stringify(data, null, 2)}\n`;
  } catch (error) {
    throw settingsError(`Settings cannot be saved: ${error.message}`, { cause: error, file: target });
  }

  try {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      throw settingsError(
        `Permission denied creating the settings directory ${dir}. Set ${SETTINGS_DIR_ENV} to a writable path.`,
        { cause: error, file: target },
      );
    }
    throw settingsError(`Cannot create the settings directory ${dir}: ${error.message}`, {
      cause: error,
      file: target,
    });
  }
  await assertNotSymlink(target);

  const tmp = path.join(dir, `.${SETTINGS_FILE_NAME}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let handle = null;
  try {
    handle = await fsp.open(tmp, 'wx', 0o600);
    await handle.writeFile(json, 'utf8');
    try {
      await handle.sync();
    } catch (error) {
      // Some filesystems do not support fsync on a file handle; the rename is
      // still atomic, so only that durability guarantee is skipped.
      if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error;
    }
    await handle.close();
    handle = null;
    await fsp.rename(tmp, target);
    // Best effort: Windows ignores POSIX modes; the file is already created 0600.
    if (process.platform !== 'win32') await fsp.chmod(target, 0o600).catch(() => {});
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsp.rm(tmp, { force: true }).catch(() => {});
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      throw settingsError(
        `Permission denied writing settings ${target}. The previous file was left unchanged.`,
        { cause: error, file: target },
      );
    }
    throw settingsError(
      `Failed to save settings ${target}: ${error.message}. The previous file was left unchanged.`,
      { cause: error, file: target },
    );
  }
  return target;
}

/**
 * Read-modify-write one save. Re-reading first means a value saved by another
 * process is never silently overwritten by a stale in-memory copy.
 */
export async function updateSettings(mutator, { file = null, ...options } = {}) {
  const target = file || settingsFile(options);
  const { data } = await readSettings({ file: target });
  const draft = cloneSettings(data);
  const next = (await mutator(draft)) ?? draft;
  await writeSettings(next, { file: target });
  return next;
}

/** Small facade over one settings file, used by both editors. */
export class SettingsStore {
  constructor({ file = null, env = process.env, home = undefined, platform = undefined } = {}) {
    this.file = file || settingsFile({ env, home, platform });
  }

  read() {
    return readSettings({ file: this.file });
  }

  save(data) {
    return writeSettings(data, { file: this.file });
  }

  update(mutator) {
    return updateSettings(mutator, { file: this.file });
  }
}

/** A fixed-width mask: the value's length and characters are never revealed. */
export function maskSettingsSecret(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? '••••••••' : '(not set)';
}

/** Persisted default provider, or null when the file does not choose one. */
export function settingsProviderId(settings) {
  return normalizeProviderId(settings?.provider) || null;
}

/** Persisted model for one provider, or null. */
export function settingsModelFor(settings, providerId) {
  const map = settings?.providerModel;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  const id = normalizeProviderId(providerId);
  if (!id || typeof map[id] !== 'string') return null;
  return normalizeModelId(map[id]);
}

/**
 * Fill the raw config from the settings file.
 *
 * Environment variables always win: settings are defaults for the values the
 * shell/.env did not set, so an existing setup keeps behaving exactly as before
 * and a one-off `NVIDIA_API_KEY=… ryuu` still overrides the stored key.
 */
export function applySettingsToRaw(raw, settings) {
  if (!raw || !settings || typeof settings !== 'object') return raw;

  const providerEnv = { ...(raw.providerEnv || {}) };
  raw.providerEnv = providerEnv;
  let extras = [];
  try {
    extras = parseExtraProviders(raw.extraProviders, []);
  } catch {
    extras = [];
  }
  for (const provider of buildProviders({ env: providerEnv, extras })) {
    const stored = settings.providers?.[provider.id];
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) continue;
    const apiKey = typeof stored.apiKey === 'string' ? stored.apiKey.trim() : '';
    if (apiKey && provider.apiKeyEnv && !providerEnv[provider.apiKeyEnv]) {
      providerEnv[provider.apiKeyEnv] = apiKey;
    }
    const baseURL = typeof stored.baseURL === 'string' ? stored.baseURL.trim() : '';
    if (baseURL && provider.baseUrlEnv && !providerEnv[provider.baseUrlEnv]) {
      providerEnv[provider.baseUrlEnv] = baseURL;
    }
  }

  const agent = settings.agent && typeof settings.agent === 'object' ? settings.agent : {};
  for (const key of AGENT_SETTING_KEYS) {
    const value = agent[key];
    if (value === undefined || value === null || value === '') continue;
    if (raw[key] === undefined || raw[key] === '') raw[key] = value;
  }

  const web = settings.webSearch && typeof settings.webSearch === 'object' ? settings.webSearch : {};
  for (const [settingsKey, rawKey] of Object.entries(WEB_SETTING_KEYS)) {
    const value = web[settingsKey];
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length === 0 || (raw[rawKey] !== undefined && raw[rawKey] !== '')) continue;
      raw[rawKey] = value.join(',');
      continue;
    }
    if (raw[rawKey] === undefined || raw[rawKey] === '') raw[rawKey] = value;
  }
  return raw;
}
