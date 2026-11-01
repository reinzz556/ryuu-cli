import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ConfigError } from '../../src/utils/errors.js';
import { settingsDir } from '../../src/config/settings.js';

/**
 * Configuration for the google-drive plugin.
 *
 * The non-sensitive settings live next to the user's config.json:
 *   <config dir>/integrations/google-drive/config.json
 * and the OAuth tokens received from the API backend live beside them in
 * `credentials.enc`.
 *
 * No Google Client ID or Client Secret exists in the CLI: both belong to the
 * root `website/api` project, which exposes `/admin/tools/drive-cli`. The
 * backend URL is a constant, so no command or environment variable can
 * redirect credentials elsewhere.
 */
export const DEFAULT_GOOGLE_DRIVE_CONFIG = Object.freeze({
  scopes: Object.freeze(['https://www.googleapis.com/auth/drive.file']),
  enabled: false,
  autoRefresh: true,
  // Backend OAuth milik proyek website/api. Keduanya konstanta aplikasi:
  // tidak ada command / env var yang boleh mengubahnya, dan CLI tidak
  // pernah menyimpan Client ID maupun Client Secret Google.
  oauthBackend: 'https://restapi.ryuu-dev.my.id',
  oauthCliPath: '/admin/tools/drive-cli',
  defaultBackupFolder: null,
  backupDirectory: 'Backups',
  confirmDestructive: true,
  maxUploadSize: 1073741824,
  excludePatterns: Object.freeze([
    'node_modules',
    '.git',
    '.env',
    '.env.*',
    '*.pem',
    '*.key',
    '*.p12',
    '*.pfx',
    'credentials.json',
    'service-account*.json',
    '*.log',
    'cache',
    'tmp',
    'temp',
  ]),
});

/** Keys the user may change with `/drive config set` (credentials are not). */
export const EDITABLE_KEYS = Object.freeze([
  'enabled',
  'defaultBackupFolder',
  'backupDirectory',
  'excludePatterns',
  'maxUploadSize',
  'confirmDestructive',
  'autoRefresh',
]);

// Client ID, Client Secret, endpoint backend, scope, dan kunci login Drive
// (lihat secret.js) adalah milik aplikasi: tidak ada jalur command untuk
// mengubahnya, jadi tidak ada nilai sensitif yang bisa ditanamkan lewat config.
const BLOCKED_KEYS = new Set([
  'clientId',
  'clientSecret',
  'scopes',
  'oauthBackend',
  'oauthCliPath',
  'rootKey',
  'driveKey',
  'secret',
  '__proto__',
  'prototype',
  'constructor',
]);

/** Absolute paths of the integration's own files. */
export function drivePaths({ env = process.env, home = undefined, platform = undefined } = {}) {
  const root = path.join(settingsDir({ env, home, platform }), 'integrations', 'google-drive');
  return {
    dir: root,
    configFile: path.join(root, 'config.json'),
    credentialFile: path.join(root, 'credentials.enc'),
    // The encryption key lives outside the integration folder on purpose: the
    // key and the ciphertext must not travel together.
    keyFile: path.join(settingsDir({ env, home, platform }), '.keys', 'google-drive.key'),
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

/** Validate one `/drive config set <key> <value>` write. */
export function validateConfigEntry(key, rawValue) {
  const name = String(key ?? '').trim();
  if (BLOCKED_KEYS.has(name)) {
    throw new ConfigError(
      `Key "${name}" tidak dapat diubah: Client ID/Secret Google, endpoint backend, dan kunci login Drive dikelola aplikasi (proyek API) dan tidak boleh diubah dari command.`,
    );
  }
  if (!EDITABLE_KEYS.includes(name)) {
    throw new ConfigError(
      `Key tidak dikenal: "${name}". Key yang didukung: ${EDITABLE_KEYS.join(', ')}.`,
    );
  }
  const issues = [];
  let value;
  switch (name) {
    case 'enabled':
    case 'confirmDestructive':
    case 'autoRefresh':
      value = boolValue(name, rawValue, issues);
      break;
    case 'defaultBackupFolder': {
      const text = String(rawValue ?? '').trim();
      if (!text || ['none', 'null', '-', 'off'].includes(text.toLowerCase())) value = null;
      else if (!/^[A-Za-z0-9_-]{10,200}$/.test(text)) {
        issues.push('defaultBackupFolder harus berupa folder ID Google Drive (10-200 karakter huruf/angka/-/_).');
      } else value = text;
      break;
    }
    case 'backupDirectory': {
      const text = String(rawValue ?? '').trim().replace(/^\/+|\/+$/g, '');
      if (!text) issues.push('backupDirectory tidak boleh kosong.');
      else if (text.length > 120 || text.split('/').some((part) => part === '..')) {
        issues.push('backupDirectory tidak valid: gunakan nama folder biasa (maksimal 120 karakter, tanpa "..").');
      } else value = text;
      break;
    }
    case 'excludePatterns': {
      const text = String(rawValue ?? '').trim();
      if (['none', 'empty', '-'].includes(text.toLowerCase())) value = [];
      else value = text.split(',').map((part) => part.trim()).filter(Boolean);
      if (Array.isArray(value) && value.some((pattern) => pattern.includes('..') || pattern.length > 100)) {
        issues.push('excludePatterns berisi pola yang tidak valid (tanpa ".." dan maksimal 100 karakter per pola).');
      }
      break;
    }
    case 'maxUploadSize': {
      const parsed = Number(String(rawValue ?? '').trim());
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) issues.push('maxUploadSize harus berupa angka byte.');
      else if (parsed < 1024 || parsed > 1073741824) {
        issues.push('maxUploadSize harus antara 1024 dan 1073741824 byte (1 GB).');
      } else value = parsed;
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
  // Only keys the application knows about survive; anything else (in
  // particular credentials smuggled into the file by hand) is dropped.
  const stored = {};
  for (const key of Object.keys(DEFAULT_GOOGLE_DRIVE_CONFIG)) {
    if (key in source) stored[key] = source[key];
  }
  const merged = { ...DEFAULT_GOOGLE_DRIVE_CONFIG, ...stored };
  // These are application-owned and always come from the defaults.
  merged.scopes = [...DEFAULT_GOOGLE_DRIVE_CONFIG.scopes];
  merged.oauthBackend = DEFAULT_GOOGLE_DRIVE_CONFIG.oauthBackend;
  merged.oauthCliPath = DEFAULT_GOOGLE_DRIVE_CONFIG.oauthCliPath;
  merged.enabled = Boolean(merged.enabled);
  merged.autoRefresh = merged.autoRefresh !== false;
  merged.confirmDestructive = merged.confirmDestructive !== false;
  merged.defaultBackupFolder =
    typeof merged.defaultBackupFolder === 'string' && merged.defaultBackupFolder.trim()
      ? merged.defaultBackupFolder.trim()
      : null;
  merged.backupDirectory =
    typeof merged.backupDirectory === 'string' && merged.backupDirectory.trim()
      ? merged.backupDirectory.trim().replace(/^\/+|\/+$/g, '')
      : DEFAULT_GOOGLE_DRIVE_CONFIG.backupDirectory;
  merged.maxUploadSize = Number.isInteger(merged.maxUploadSize)
    ? merged.maxUploadSize
    : DEFAULT_GOOGLE_DRIVE_CONFIG.maxUploadSize;
  merged.excludePatterns = Array.isArray(merged.excludePatterns)
    ? merged.excludePatterns.map((item) => String(item)).filter(Boolean)
    : [...DEFAULT_GOOGLE_DRIVE_CONFIG.excludePatterns];
  return merged;
}

/** Read the integration config; a missing file yields the built-in defaults. */
export async function readDriveConfig({ paths = drivePaths() } = {}) {
  let text;
  try {
    text = await fsp.readFile(paths.configFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return normalize({});
    throw new ConfigError(`Tidak dapat membaca konfigurasi Google Drive (${paths.configFile}): ${error.message}`);
  }
  try {
    return normalize(JSON.parse(text));
  } catch (error) {
    throw new ConfigError(
      `Konfigurasi Google Drive tidak valid (${paths.configFile}): ${error.message}. File tidak diubah — perbaiki atau hapus file tersebut.`,
    );
  }
}

/** Write the integration config atomically with owner-only permissions. */
export async function writeDriveConfig(config, { paths = drivePaths() } = {}) {
  const data = normalize(config);
  await fsp.mkdir(paths.dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(paths.dir, `.config.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await fsp.rename(tmp, paths.configFile);
    if (process.platform !== 'win32') await fsp.chmod(paths.configFile, 0o600).catch(() => {});
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw new ConfigError(`Gagal menyimpan konfigurasi Google Drive: ${error.message}`);
  }
  return data;
}

/** Read-modify-write one setting so concurrent saves are not lost. */
export async function updateDriveConfig(key, value, { paths = drivePaths() } = {}) {
  const current = await readDriveConfig({ paths });
  current[key] = value;
  return writeDriveConfig(current, { paths });
}

/** Short human-readable view of the non-sensitive configuration. */
export function describeDriveConfig(config) {
  return {
    enabled: config.enabled ? 'true' : 'false',
    autoRefresh: config.autoRefresh ? 'true' : 'false',
    oauthBackend: config.oauthBackend,
    oauthCliPath: config.oauthCliPath,
    loginKey: 'bawaan aplikasi (tidak dapat diubah, tidak pernah ditampilkan)',
    confirmDestructive: config.confirmDestructive ? 'true' : 'false',
    defaultBackupFolder: config.defaultBackupFolder || '(belum diatur)',
    backupDirectory: config.backupDirectory,
    maxUploadSize: `${config.maxUploadSize} byte`,
    excludePatterns: config.excludePatterns.join(', ') || '(kosong)',
    scopes: config.scopes.join(', '),
    credentials: 'disimpan di backend API (CLI tidak memegang Client ID/Secret)',
  };
}
