import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { GitHubPluginError, GITHUB_CODES } from './errors.js';

/**
 * Penyimpanan kredensial CLI.
 *
 * Yang disimpan HANYA `cliToken` terbitan backend dan cache identitas akun.
 * Access token/refresh token GitHub tetap di server dan tidak pernah menyentuh
 * disk CLI. File dienkripsi AES-256-GCM; kunci 32 byte hidup di direktori lain
 * (`<config>/.keys/github.key`, mode 0600) atau dari `RYUU_GITHUB_KEY`.
 */
const KEY_BYTES = 32;
const MAGIC = 'RYUUGITHB1';

const credentialError = (message, details = null) =>
  new GitHubPluginError(message, { code: GITHUB_CODES.CREDENTIAL, details });

function decodeEnvKey(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const buffer = /^[0-9a-fA-F]{64}$/.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  if (buffer.length !== KEY_BYTES) {
    throw credentialError('RYUU_GITHUB_KEY tidak valid: butuh 32 byte (hex 64 karakter atau base64).');
  }
  return buffer;
}

async function readOrCreateKey(keyFile, { env = process.env } = {}) {
  const fromEnv = decodeEnvKey(env.RYUU_GITHUB_KEY);
  if (fromEnv) return fromEnv;
  try {
    const existing = await fsp.readFile(keyFile);
    if (existing.length === KEY_BYTES) return existing;
    throw credentialError(`File kunci GitHub rusak (${keyFile}). Hapus file tersebut lalu jalankan /github login.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const key = crypto.randomBytes(KEY_BYTES);
  await fsp.mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  try {
    await fsp.writeFile(keyFile, key, { mode: 0o600, flag: 'wx' });
    if (process.platform !== 'win32') await fsp.chmod(keyFile, 0o600).catch(() => {});
    return key;
  } catch (error) {
    if (error.code !== 'EEXIST') throw credentialError(`Gagal menyimpan kunci kredensial GitHub: ${error.message}`);
    const again = await fsp.readFile(keyFile);
    if (again.length !== KEY_BYTES) throw credentialError(`File kunci GitHub rusak (${keyFile}).`);
    return again;
  }
}

/** Simpan cliToken + cache akun. Nilai lain dibuang. */
export async function saveCredentials(
  { cliToken, ryuuUserId = null, cliTokenExpiresAt = null, account = null, backend = null },
  { paths, env = process.env } = {},
) {
  if (typeof cliToken !== 'string' || !cliToken.startsWith('ghcli_')) {
    throw credentialError('Token akses CLI tidak valid.');
  }
  const payload = {
    version: 2,
    cliToken,
    ryuuUserId: typeof ryuuUserId === 'string' ? ryuuUserId : null,
    cliTokenExpiresAt: typeof cliTokenExpiresAt === 'string' ? cliTokenExpiresAt : null,
    backend: typeof backend === 'string' ? backend : null,
    account: account
      ? {
          githubUserId: account.githubUserId || account.id || null,
          login: account.login || null,
          name: account.name || null,
          avatarUrl: account.avatarUrl || null,
          htmlUrl: account.htmlUrl || null,
          type: account.type || 'User',
          scope: account.scope || '',
        }
      : null,
    savedAt: new Date().toISOString(),
  };
  const key = await readOrCreateKey(paths.keyFile, { env });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const file = Buffer.concat([Buffer.from(MAGIC, 'utf8'), iv, tag, encrypted]);

  await fsp.mkdir(paths.dir, { recursive: true, mode: 0o700 });
  const tmp = `${paths.credentialFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, file, { mode: 0o600 });
    await fsp.rename(tmp, paths.credentialFile);
    if (process.platform !== 'win32') await fsp.chmod(paths.credentialFile, 0o600).catch(() => {});
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw credentialError(`Gagal menyimpan kredensial GitHub: ${error.message}`);
  }
  return { file: paths.credentialFile, savedAt: payload.savedAt };
}

/** Baca dan dekripsi kredensial; null bila belum login. */
export async function loadCredentials({ paths, env = process.env } = {}) {
  let raw;
  try {
    raw = await fsp.readFile(paths.credentialFile);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      throw credentialError(`Izin ditolak saat membaca kredensial GitHub (${paths.credentialFile}).`);
    }
    throw credentialError(`Gagal membaca kredensial GitHub: ${error.message}`);
  }
  if (raw.length < MAGIC.length + 28) throw credentialError('File kredensial GitHub rusak. Jalankan /github login.');
  if (raw.subarray(0, MAGIC.length).toString('utf8') !== MAGIC) {
    throw credentialError('Format file kredensial GitHub tidak dikenali. Jalankan /github login.');
  }
  let key;
  try {
    key = await readOrCreateKey(paths.keyFile, { env });
  } catch (error) {
    if (error.code === GITHUB_CODES.CREDENTIAL) throw error;
    throw credentialError(`Kunci kredensial GitHub tidak tersedia: ${error.message}`);
  }
  const iv = raw.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = raw.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const body = raw.subarray(MAGIC.length + 28);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    return JSON.parse(json);
  } catch {
    throw credentialError(
      'Kredensial GitHub tidak dapat didekripsi (kunci berbeda atau file rusak). Jalankan /github login untuk menghubungkan ulang.',
    );
  }
}

/** Hapus kredensial lokal beserta kunci CLI. */
export async function clearCredentials({ paths, env = process.env } = {}) {
  await fsp.rm(paths.credentialFile, { force: true });
  if (!env.RYUU_GITHUB_KEY) await fsp.rm(paths.keyFile, { force: true }).catch(() => {});
  return true;
}

/** Metadata aman dicetak: tidak pernah memuat cliToken. */
export function describeCredentials(stored) {
  if (!stored) return { connected: false };
  return {
    connected: Boolean(stored.cliToken),
    login: stored.account?.login || null,
    name: stored.account?.name || null,
    type: stored.account?.type || null,
    scope: stored.account?.scope || '',
    ryuuUserId: stored.ryuuUserId || null,
    cliTokenExpiresAt: stored.cliTokenExpiresAt || null,
    backend: stored.backend || null,
    savedAt: stored.savedAt || null,
  };
}
