import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { RyuuError } from '../../../../src/utils/errors.js';

/**
 * Credential storage for the google-drive integration.
 *
 * Tokens are never written in plaintext. The file is AES-256-GCM encrypted and
 * the key lives in a different directory (`<config>/.keys/google-drive.key`,
 * mode 0600) so a copied credential file is useless on its own. `RYUU_DRIVE_KEY`
 * (hex or base64, 32 bytes) can supply the key instead, which is what a VPS or
 * a secret manager should use.
 *
 * Nothing in this module ever logs or returns a token to the UI: callers get
 * metadata only.
 */

const KEY_BYTES = 32;
const MAGIC = 'RYUUDRIVE1';

function credentialError(message, { cause = null } = {}) {
  return new RyuuError(message, { code: 'DRIVE_CREDENTIAL', cause });
}

function decodeEnvKey(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const buffer = /^[0-9a-fA-F]{64}$/.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  if (buffer.length !== KEY_BYTES) {
    throw credentialError('RYUU_DRIVE_KEY tidak valid: butuh 32 byte (hex 64 karakter atau base64).');
  }
  return buffer;
}

async function readOrCreateKey(keyFile, { env = process.env } = {}) {
  const fromEnv = decodeEnvKey(env.RYUU_DRIVE_KEY);
  if (fromEnv) return fromEnv;
  try {
    const existing = await fsp.readFile(keyFile);
    if (existing.length === KEY_BYTES) return existing;
    throw credentialError(`File kunci Google Drive rusak (${keyFile}). Hapus file tersebut lalu jalankan /drive login.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const key = crypto.randomBytes(KEY_BYTES);
  await fsp.mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  // `wx` fails if another process created it first; read theirs in that case.
  try {
    await fsp.writeFile(keyFile, key, { mode: 0o600, flag: 'wx' });
    if (process.platform !== 'win32') await fsp.chmod(keyFile, 0o600).catch(() => {});
    return key;
  } catch (error) {
    if (error.code !== 'EEXIST') throw credentialError(`Gagal menyimpan kunci kredensial: ${error.message}`);
    const again = await fsp.readFile(keyFile);
    if (again.length !== KEY_BYTES) throw credentialError(`File kunci Google Drive rusak (${keyFile}).`);
    return again;
  }
}

/**
 * Encrypt and store the OAuth tokens.
 *
 * Only the fields below are persisted; anything else is dropped so an API
 * response can never smuggle a token into the file by accident.
 */
export async function saveCredentials({ tokens, account = null }, { paths, env = process.env } = {}) {
  if (!tokens || typeof tokens !== 'object') throw credentialError('Token OAuth tidak tersedia.');
  const payload = {
    version: 2,
    // Izin sempit dari backend: cukup untuk refresh/revoke tanpa kunci aplikasi.
    grantId: typeof tokens.grant_id === 'string' ? tokens.grant_id : null,
    accessToken: typeof tokens.access_token === 'string' ? tokens.access_token : null,
    refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : null,
    expiryDate: Number.isFinite(tokens.expiry_date) ? tokens.expiry_date : null,
    tokenType: typeof tokens.token_type === 'string' ? tokens.token_type : 'Bearer',
    scope: typeof tokens.scope === 'string' ? tokens.scope : '',
    account: account
      ? {
          email: account.email || null,
          name: account.name || null,
          permissionId: account.permissionId || null,
          storageQuota: account.storageQuota || null,
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
    throw credentialError(`Gagal menyimpan kredensial Google Drive: ${error.message}`);
  }
  return { file: paths.credentialFile, savedAt: payload.savedAt };
}

/** Read and decrypt the stored tokens. Returns null when nothing is stored. */
export async function loadCredentials({ paths, env = process.env } = {}) {
  let raw;
  try {
    raw = await fsp.readFile(paths.credentialFile);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      throw credentialError(`Izin ditolak saat membaca kredensial Google Drive (${paths.credentialFile}).`);
    }
    throw credentialError(`Gagal membaca kredensial Google Drive: ${error.message}`);
  }
  if (raw.length < MAGIC.length + 28) throw credentialError('File kredensial Google Drive rusak. Jalankan /drive login.');
  if (raw.subarray(0, MAGIC.length).toString('utf8') !== MAGIC) {
    throw credentialError('Format file kredensial Google Drive tidak dikenali. Jalankan /drive login.');
  }
  let key;
  try {
    key = await readOrCreateKey(paths.keyFile, { env });
  } catch (error) {
    if (error.code === 'DRIVE_CREDENTIAL') throw error;
    throw credentialError(`Kunci kredensial Google Drive tidak tersedia: ${error.message}`);
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
      'Kredensial Google Drive tidak dapat didekripsi (kunci berbeda atau file rusak). Jalankan /drive login untuk menghubungkan ulang.',
    );
  }
}

/** Delete the stored credentials. The encryption key is removed too. */
export async function clearCredentials({ paths, env = process.env } = {}) {
  let removed = false;
  try {
    await fsp.rm(paths.credentialFile, { force: true });
    removed = true;
  } catch (error) {
    throw credentialError(`Gagal menghapus kredensial Google Drive: ${error.message}`);
  }
  if (!env.RYUU_DRIVE_KEY) await fsp.rm(paths.keyFile, { force: true }).catch(() => {});
  return removed;
}

/** Metadata only — safe to print. Never contains a token. */
export function describeCredentials(stored) {
  if (!stored) return { connected: false };
  return {
    connected: Boolean(stored.refreshToken || stored.accessToken || stored.grantId),
    hasRefreshToken: Boolean(stored.refreshToken || stored.grantId),
    expiresAt: stored.expiryDate ? new Date(stored.expiryDate).toISOString() : null,
    scope: stored.scope || '',
    email: stored.account?.email || null,
    name: stored.account?.name || null,
    savedAt: stored.savedAt || null,
  };
}
