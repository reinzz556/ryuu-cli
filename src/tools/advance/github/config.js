import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { ConfigError } from '../../../../src/utils/errors.js';
import { settingsDir } from '../../../../src/config/settings.js';

/**
 * Konfigurasi plugin GitHub di sisi CLI.
 *
 * Yang disimpan di sini hanya pengaturan non-rahasia: status aktif, preferensi
 * perilaku, dan Client ID publik milik GitHub App. Client Secret, Private Key,
 * Webhook Secret, access token, dan refresh token TIDAK PERNAH ada di CLI —
 * semuanya dimiliki backend.
 *
 * Lokasi mengikuti direktori konfigurasi OS lewat `settingsDir()`:
 *   <config>/integrations/github/config.json
 *   <config>/integrations/github/state.json   (cache non-sensitif)
 *   <config>/integrations/github/credentials.enc
 *   <config>/.keys/github.key                 (kunci enkripsi CLI token)
 */
export const GITHUB_BACKEND_URL = 'https://restapi.ryuu-dev.my.id';
export const GITHUB_CLIENT_ID = 'Iv23liIt8Xh4waFhX0y1';

export const DEFAULT_GITHUB_CONFIG = Object.freeze({
  enabled: false,
  autoRefresh: true,
  confirmDestructive: true,
  defaultRepo: null,
  // Client ID bukan rahasia; dipakai untuk ditampilkan pada /github config.
  clientId: GITHUB_CLIENT_ID,
  // Endpoint backend adalah konstanta aplikasi, bukan pengaturan pengguna.
  backend: GITHUB_BACKEND_URL,
});

export const EDITABLE_KEYS = Object.freeze(['enabled', 'autoRefresh', 'confirmDestructive', 'defaultRepo']);

const BLOCKED_KEYS = new Set([
  'clientSecret',
  'privateKey',
  'privateKeyPath',
  'webhookSecret',
  'backend',
  'clientId',
  'accessToken',
  'refreshToken',
  'cliToken',
  'token',
  'secret',
  '__proto__',
  'prototype',
  'constructor',
]);

/** Path absolut file milik integrasi GitHub di sisi CLI. */
export function githubPaths({ env = process.env, home = undefined, platform = undefined } = {}) {
  const root = path.join(settingsDir({ env, home, platform }), 'integrations', 'github');
  return {
    dir: root,
    configFile: path.join(root, 'config.json'),
    credentialFile: path.join(root, 'credentials.enc'),
    stateFile: path.join(root, 'state.json'),
    keyFile: path.join(settingsDir({ env, home, platform }), '.keys', 'github.key'),
  };
}

function boolValue(name, value, issues) {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on', 'enable', 'enabled', 'aktif'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off', 'disable', 'disabled', 'nonaktif'].includes(text)) return false;
  issues.push(`${name} harus berupa boolean (true/false), diterima: ${JSON.stringify(value)}`);
  return undefined;
}

/** Validasi satu penulisan `/github config set <key> <value>`. */
export function validateConfigEntry(key, rawValue) {
  const name = String(key ?? '').trim();
  if (BLOCKED_KEYS.has(name)) {
    throw new ConfigError(
      `Key "${name}" tidak dapat diubah: Client Secret, Private Key, Webhook Secret, endpoint backend, dan token dikelola backend dan tidak boleh ada di CLI.`,
    );
  }
  if (!EDITABLE_KEYS.includes(name)) {
    throw new ConfigError(`Key tidak dikenal: "${name}". Key yang didukung: ${EDITABLE_KEYS.join(', ')}.`);
  }
  const issues = [];
  let value;
  switch (name) {
    case 'enabled':
    case 'autoRefresh':
    case 'confirmDestructive':
      value = boolValue(name, rawValue, issues);
      break;
    case 'defaultRepo': {
      const text = String(rawValue ?? '').trim();
      if (!text || ['none', 'null', '-', 'off'].includes(text.toLowerCase())) value = null;
      else if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(text)) {
        issues.push('defaultRepo harus berformat owner/repo, contoh: ryuu-reinzz/ryuu-cli.');
      } else value = text;
      break;
    }
    default:
      issues.push(`Key tidak dikenal: ${name}`);
  }
  if (issues.length > 0) throw new ConfigError(issues.join(' '), { key: name });
  return value;
}

function normalize(data) {
  const source = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const stored = {};
  for (const key of Object.keys(DEFAULT_GITHUB_CONFIG)) {
    if (key in source) stored[key] = source[key];
  }
  const merged = { ...DEFAULT_GITHUB_CONFIG, ...stored };
  // Nilai milik aplikasi selalu kembali ke default.
  merged.clientId = GITHUB_CLIENT_ID;
  merged.backend = GITHUB_BACKEND_URL;
  merged.enabled = Boolean(merged.enabled);
  merged.autoRefresh = merged.autoRefresh !== false;
  merged.confirmDestructive = merged.confirmDestructive !== false;
  merged.defaultRepo =
    typeof merged.defaultRepo === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(merged.defaultRepo)
      ? merged.defaultRepo
      : null;
  return merged;
}

/** Baca konfigurasi; file hilang menghasilkan default bawaan. */
export async function readGitHubConfig({ paths = githubPaths() } = {}) {
  let text;
  try {
    text = await fsp.readFile(paths.configFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return normalize({});
    throw new ConfigError(`Tidak dapat membaca konfigurasi GitHub (${paths.configFile}): ${error.message}`);
  }
  try {
    return normalize(JSON.parse(text));
  } catch (error) {
    throw new ConfigError(
      `Konfigurasi GitHub tidak valid (${paths.configFile}): ${error.message}. File tidak diubah — perbaiki atau hapus file tersebut.`,
    );
  }
}

/** Tulis konfigurasi secara atomik dengan permission 0600. */
export async function writeGitHubConfig(config, { paths = githubPaths() } = {}) {
  const data = normalize(config);
  await fsp.mkdir(paths.dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(paths.dir, `.config.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await fsp.rename(tmp, paths.configFile);
    if (process.platform !== 'win32') await fsp.chmod(paths.configFile, 0o600).catch(() => {});
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw new ConfigError(`Gagal menyimpan konfigurasi GitHub: ${error.message}`);
  }
  return data;
}

/** Read-modify-write satu key agar perubahan lain tidak hilang. */
export async function updateGitHubConfig(key, value, { paths = githubPaths() } = {}) {
  const current = await readGitHubConfig({ paths });
  current[key] = value;
  return writeGitHubConfig(current, { paths });
}

/** Cache non-sensitif: kapan terakhir backend diperiksa dan hasilnya. */
export async function readGitHubState({ paths = githubPaths() } = {}) {
  try {
    const parsed = JSON.parse(await fsp.readFile(paths.stateFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeGitHubState(state, { paths = githubPaths() } = {}) {
  const data = state && typeof state === 'object' ? state : {};
  await fsp.mkdir(paths.dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(paths.dir, `.state.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await fsp.rename(tmp, paths.stateFile);
    if (process.platform !== 'win32') await fsp.chmod(paths.stateFile, 0o600).catch(() => {});
  } catch {
    // Cache tidak boleh menggagalkan operasi utama.
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
  return data;
}

/** Tampilan konfigurasi non-rahasia untuk `/github config`. */
export function describeGitHubConfig(config) {
  return {
    enabled: config.enabled ? 'true' : 'false',
    autoRefresh: config.autoRefresh ? 'true' : 'false',
    confirmDestructive: config.confirmDestructive ? 'true' : 'false',
    defaultRepo: config.defaultRepo || '(belum diatur)',
    clientId: config.clientId,
    backend: config.backend,
    clientSecret: 'tidak ada di CLI (disimpan di backend)',
    privateKey: 'tidak ada di CLI (disimpan di backend)',
    webhookSecret: 'tidak ada di CLI (disimpan di backend)',
  };
}
