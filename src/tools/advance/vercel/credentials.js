import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { VercelPluginError, VERCEL_CODES } from './errors.js';

/**
 * Penyimpanan kredensial CLI Vercel.
 *
 * Yang disimpan HANYA `cliToken` terbitan backend dan cache identitas akun.
 * Access token Vercel tetap di server dan tidak pernah menyentuh disk CLI.
 * File dienkripsi AES-256-GCM; kunci 32 byte hidup di direktori lain
 * (`<config>/.keys/vercel.key`, mode 0600) atau dari `RYUU_VERCEL_KEY`.
 */
const KEY_BYTES = 32;
const MAGIC = 'RYUUVERC1';

const credentialError = (message, details = null) =>
  new VercelPluginError(message, { code: VERCEL_CODES.CREDENTIAL, details });

function decodeEnvKey(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const buffer = /^[0-9a-fA-F]{64}$/.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  if (buffer.length !== KEY_BYTES) {
    throw credentialError('RYUU_VERCEL_KEY tidak valid: butuh 32 byte (hex 64 karakter atau base64).');
  }
  return buffer;
}

async function readOrCreateKey(keyFile, { env = process.env } = {}) {
  const fromEnv = decodeEnvKey(env.RYUU_VERCEL_KEY);
  if (fromEnv) return fromEnv;
  try {
    const existing = await fsp.readFile(keyFile);
    if (existing.length === KEY_BYTES) return existing;
    throw credentialError(`File kunci Vercel rusak (${keyFile}). Hapus file tersebut lalu jalankan /vercel login.`);
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
    if (error.code !== 'EEXIST') throw credentialError(`Gagal menyimpan kunci kredensial Vercel: ${error.message}`);
    const again = await fsp.readFile(keyFile);
    if (again.length !== KEY_BYTES) throw credentialError(`File kunci Vercel rusak (${keyFile}).`);
    return again;
  }
}

/** Simpan cliToken + cache akun/configuration. Nilai lain dibuang. */
export async function saveCredentials(
  { cliToken, ryuuUserId = null, cliTokenExpiresAt = null, account = null, configuration = null, backend = null },
  { paths, env = process.env } = {},
) {
  if (typeof cliToken !== 'string' || !cliToken.startsWith('vcli_')) {
    throw credentialError('Token akses CLI tidak valid.');
  }
  const payload = {
    version: 1,
    cliToken,
    ryuuUserId: typeof ryuuUserId === 'string' ? ryuuUserId : null,
    cliTokenExpiresAt: typeof cliTokenExpiresAt === 'string' ? cliTokenExpiresAt : null,
    backend: typeof backend === 'string' ? backend : null,
    account: account
      ? {
          vercelUserId: account.vercelUserId || account.id || null,
          username: account.username || null,
          name: account.name || null,
          email: account.email || null,
          avatarUrl: account.avatarUrl || null,
        }
      : null,
    configuration: configuration
      ? {
          id: configuration.id || null,
          teamId: configuration.teamId || null,
          slug: configuration.slug || null,
          name: configuration.name || null,
          status: configuration.status || null,
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
    throw credentialError(`Gagal menyimpan kredensial Vercel: ${error.message}`);
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
      throw credentialError(`Izin ditolak saat membaca kredensial Vercel (${paths.credentialFile}).`);
    }
    throw credentialError(`Gagal membaca kredensial Vercel: ${error.message}`);
  }
  if (raw.length < MAGIC.length + 28) throw credentialError('File kredensial Vercel rusak. Jalankan /vercel login.');
  if (raw.subarray(0, MAGIC.length).toString('utf8') !== MAGIC) {
    throw credentialError('Format file kredensial Vercel tidak dikenali. Jalankan /vercel login.');
  }
  let key;
  try {
    key = await readOrCreateKey(paths.keyFile, { env });
  } catch (error) {
    if (error.code === VERCEL_CODES.CREDENTIAL) throw error;
    throw credentialError(`Kunci kredensial Vercel tidak tersedia: ${error.message}`);
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
      'Kredensial Vercel tidak dapat didekripsi (kunci berbeda atau file rusak). Jalankan /vercel login untuk menghubungkan ulang.',
    );
  }
}

/** Hapus kredensial lokal beserta kunci CLI. */
export async function clearCredentials({ paths, env = process.env } = {}) {
  await fsp.rm(paths.credentialFile, { force: true });
  if (!env.RYUU_VERCEL_KEY) await fsp.rm(paths.keyFile, { force: true }).catch(() => {});
  return true;
}

/** Metadata aman dicetak: tidak pernah memuat cliToken. */
export function describeCredentials(stored) {
  if (!stored) return { connected: false };
  return {
    connected: Boolean(stored.cliToken),
    username: stored.account?.username || null,
    name: stored.account?.name || null,
    email: stored.account?.email || null,
    ryuuUserId: stored.ryuuUserId || null,
    cliTokenExpiresAt: stored.cliTokenExpiresAt || null,
    configuration: stored.configuration || null,
    backend: stored.backend || null,
    savedAt: stored.savedAt || null,
  };
}
