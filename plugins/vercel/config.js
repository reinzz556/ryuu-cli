import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { ConfigError } from '../../src/utils/errors.js';
import { settingsDir } from '../../src/config/settings.js';

/**
 * Konfigurasi plugin Vercel di sisi CLI.
 *
 * Yang disimpan hanya pengaturan non-rahasia: status aktif, preferensi
 * perilaku, dan default team/project. Client Secret, access token, dan refresh
 * token TIDAK PERNAH ada di CLI — semuanya milik backend.
 *
 * Lokasi mengikuti direktori konfigurasi OS lewat `settingsDir()`:
 *   <config>/integrations/vercel/config.json
 *   <config>/integrations/vercel/state.json     (cache non-sensitif)
 *   <config>/integrations/vercel/credentials.enc
 *   <config>/.keys/vercel.key                   (kunci enkripsi cliToken)
 */
export const VERCEL_BACKEND_URL = 'https://restapi.ryuu-dev.my.id';
/** Client ID integrasi bersifat publik; Client Secret tetap hanya di backend. */
export const VERCEL_CLIENT_ID = 'oac_QIA7cjvSFkhNHbGKCxl2vkR9';

export const DEFAULT_VERCEL_CONFIG = Object.freeze({
  enabled: false,
  autoRefresh: true,
  confirmDestructive: true,
  defaultTeam: null,
  defaultProject: null,
  clientId: VERCEL_CLIENT_ID,
  backend: VERCEL_BACKEND_URL,
});

export const EDITABLE_KEYS = Object.freeze([
  'enabled',
  'autoRefresh',
  'confirmDestructive',
  'defaultTeam',
  'defaultProject',
]);

const BLOCKED_KEYS = new Set([
  'clientSecret',
  'clientId',
  'webhookSecret',
  'backend',
  'accessToken',
  'refreshToken',
  'cliToken',
  'token',
  'secret',
  '__proto__',
  'prototype',
  'constructor',
]);

const TEAM_RE = /^team_[A-Za-z0-9]{6,40}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Path absolut file milik integrasi Vercel di sisi CLI. */
export function vercelPaths({ env = process.env, home = undefined, platform = undefined } = {}) {
  const root = path.join(settingsDir({ env, home, platform }), 'integrations', 'vercel');
  return {
    dir: root,
    configFile: path.join(root, 'config.json'),
    credentialFile: path.join(root, 'credentials.enc'),
    stateFile: path.join(root, 'state.json'),
    keyFile: path.join(settingsDir({ env, home, platform }), '.keys', 'vercel.key'),
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

/** Validasi satu penulisan `/vercel config set <key> <value>`. */
export function validateConfigEntry(key, rawValue) {
  const name = String(key ?? '').trim();
  if (BLOCKED_KEYS.has(name)) {
    throw new ConfigError(
      `Key "${name}" tidak dapat diubah: Client Secret, Webhook Secret, endpoint backend, dan token dikelola backend dan tidak boleh ada di CLI.`,
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
    case 'defaultTeam': {
      const text = String(rawValue ?? '').trim();
      if (!text || ['none', 'null', '-', 'off'].includes(text.toLowerCase())) value = null;
      else if (!TEAM_RE.test(text)) issues.push('defaultTeam harus berupa ID Vercel berformat team_xxx.');
      else value = text;
      break;
    }
    case 'defaultProject': {
      const text = String(rawValue ?? '').trim();
      if (!text || ['none', 'null', '-', 'off'].includes(text.toLowerCase())) value = null;
      else if (!PROJECT_RE.test(text)) issues.push('defaultProject harus berupa nama project Vercel tanpa spasi.');
      else value = text;
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
  for (const key of Object.keys(DEFAULT_VERCEL_CONFIG)) {
    if (key in source) stored[key] = source[key];
  }
  const merged = { ...DEFAULT_VERCEL_CONFIG, ...stored };
  // Nilai milik aplikasi selalu kembali ke default.
  merged.clientId = VERCEL_CLIENT_ID;
  merged.backend = VERCEL_BACKEND_URL;
  merged.enabled = Boolean(merged.enabled);
  merged.autoRefresh = merged.autoRefresh !== false;
  merged.confirmDestructive = merged.confirmDestructive !== false;
  merged.defaultTeam = typeof merged.defaultTeam === 'string' && TEAM_RE.test(merged.defaultTeam) ? merged.defaultTeam : null;
  merged.defaultProject =
    typeof merged.defaultProject === 'string' && PROJECT_RE.test(merged.defaultProject) ? merged.defaultProject : null;
  return merged;
}

/** Petunjuk perbaikan yang selalu ikut pada error konfigurasi. */
export const CONFIG_REPAIR_HINT =
  'File tidak diubah oleh Ryuu. Perbaiki isinya menjadi objek JSON yang valid, atau hapus file tersebut — Ryuu akan membuat ulang file itu dengan nilai default.';

/** Contoh isi file yang valid (tanpa rahasia apa pun). */
export function exampleVercelConfig() {
  return normalize({});
}

function parseVercelConfigText(text, paths) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(
      `Konfigurasi Vercel tidak valid di ${paths.configFile}: ${error.message}. ${CONFIG_REPAIR_HINT}`,
      { path: paths.configFile, reason: error.message },
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const found = Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed;
    throw new ConfigError(
      `Konfigurasi Vercel di ${paths.configFile} harus berupa objek JSON, ditemukan ${found}. ${CONFIG_REPAIR_HINT}`,
      { path: paths.configFile, reason: `bukan objek JSON (${found})` },
    );
  }
  return normalize(parsed);
}

/** Baca konfigurasi; file hilang menghasilkan default bawaan tanpa menulis. */
export async function readVercelConfig({ paths = vercelPaths() } = {}) {
  let text;
  try {
    text = await fsp.readFile(paths.configFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return normalize({});
    throw new ConfigError(`Tidak dapat membaca konfigurasi Vercel (${paths.configFile}): ${error.message}`, {
      path: paths.configFile,
      reason: error.message,
    });
  }
  return parseVercelConfigText(text, paths);
}

/**
 * Pastikan file konfigurasi tersedia.
 *
 * File yang belum ada dibuat otomatis dari default (mode 0600) sehingga
 * pengguna tidak perlu menulis file sendiri. File yang ada tetapi tidak valid
 * TIDAK ditimpa: error yang jelas dilempar agar pengguna memperbaikinya dan
 * pesan itu dapat ditampilkan di terminal.
 */
export async function ensureVercelConfig({ paths = vercelPaths() } = {}) {
  let text;
  try {
    text = await fsp.readFile(paths.configFile, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new ConfigError(`Tidak dapat membaca konfigurasi Vercel (${paths.configFile}): ${error.message}`, {
        path: paths.configFile,
        reason: error.message,
      });
    }
    const config = await writeVercelConfig(normalize({}), { paths });
    return { config, created: true };
  }
  return { config: parseVercelConfigText(text, paths), created: false };
}

/** Tulis konfigurasi secara atomik dengan permission 0600. */
export async function writeVercelConfig(config, { paths = vercelPaths() } = {}) {
  const data = normalize(config);
  await fsp.mkdir(paths.dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(paths.dir, `.config.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await fsp.rename(tmp, paths.configFile);
    if (process.platform !== 'win32') await fsp.chmod(paths.configFile, 0o600).catch(() => {});
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw new ConfigError(`Gagal menyimpan konfigurasi Vercel: ${error.message}`);
  }
  return data;
}

/** Read-modify-write satu key agar perubahan lain tidak hilang. */
export async function updateVercelConfig(key, value, { paths = vercelPaths() } = {}) {
  const current = await readVercelConfig({ paths });
  current[key] = value;
  return writeVercelConfig(current, { paths });
}

/** Cache non-sensitif: kapan terakhir backend diperiksa dan hasilnya. */
export async function readVercelState({ paths = vercelPaths() } = {}) {
  try {
    const parsed = JSON.parse(await fsp.readFile(paths.stateFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeVercelState(state, { paths = vercelPaths() } = {}) {
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

/** Tampilan konfigurasi non-rahasia untuk `/vercel config`. */
export function describeVercelConfig(config) {
  return {
    enabled: config.enabled ? 'true' : 'false',
    autoRefresh: config.autoRefresh ? 'true' : 'false',
    confirmDestructive: config.confirmDestructive ? 'true' : 'false',
    defaultTeam: config.defaultTeam || '(belum diatur)',
    defaultProject: config.defaultProject || '(belum diatur)',
    clientId: config.clientId,
    backend: config.backend,
    clientSecret: 'tidak ada di CLI (disimpan di backend)',
    accessToken: 'tidak ada di CLI (disimpan di backend, terenkripsi)',
  };
}

/** URL halaman konfigurasi integrasi di backend. */
export function configurationPageUrl(config, { configurationId = null } = {}) {
  const base = String(config?.backend || VERCEL_BACKEND_URL).replace(/\/+$/, '');
  const url = new URL(`${base}/integrations/vercel/configure`);
  if (configurationId) url.searchParams.set('configurationId', configurationId);
  return url.toString();
}
