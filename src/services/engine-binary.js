/**
 * Pemilihan binary engine monetisasi dari backend.
 *
 * Saat Ryuu berjalan, platform/arsitektur runtime dikirim ke
 * `restapi.ryuu-dev.my.id`, backend memilih prebuild yang cocok, lalu binary
 * diunduh ke cache pengguna. Setiap binary diverifikasi (hash + ukuran) sebelum
 * ditulis dan sebelum dimuat; kegagalan apa pun membuat iklan dilewati, bukan
 * memuat file yang tidak tepercaya.
 *
 * Cache disimpan per-target di `<config>/engine/<target>/current/`:
 *   engine.node  — binary hasil unduhan
 *   entry.json   — versi, sha256, ukuran, waktu diambil
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { settingsDir } from '../config/settings.js';

export const DEFAULT_ENGINE_API_BASE = 'https://restapi.ryuu-dev.my.id';
export const ENGINE_REFRESH_MS = 6 * 60 * 60 * 1000;
export const ENGINE_MAX_BYTES = 8 * 1024 * 1024;

const CHECKSUM_RE = /^[a-f0-9]{64}$/;

/** glibc vs musl pada Linux; null di platform lain. */
export function detectLinuxLibc() {
  if (process.platform !== 'linux') return null;
  try {
    const report = process.report?.getReport?.();
    if (report?.header?.glibcVersionRuntime) return 'glibc';
  } catch {
    // laporan runtime tidak tersedia
  }
  return 'musl';
}

/** Target prebuild untuk runtime ini (atau platform yang diminta). */
export function engineTarget({ platform = process.platform, arch = process.arch } = {}) {
  const libc = platform === 'linux' ? detectLinuxLibc() : null;
  return { platform, arch, libc, target: `${platform}-${arch}${libc === 'musl' ? '-musl' : ''}` };
}

export function engineCacheDir({ env = process.env } = {}) {
  const override = env.RYUU_ENGINE_CACHE;
  if (typeof override === 'string' && override.trim()) return path.resolve(override.trim());
  return path.join(settingsDir({ env }), 'engine');
}

function cachePaths(cacheDir, target) {
  const dir = path.join(cacheDir, target, 'current');
  return { dir, file: path.join(dir, 'engine.node'), entryFile: path.join(dir, 'entry.json') };
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readEntry(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Baca binary yang sudah diunduh dan pastikan masih utuh.
 *
 * @returns {{ok: true, path: string, entry: object} | {ok: false, reason: string}}
 */
export function readCachedEngine({
  cacheDir = engineCacheDir(),
  platform = process.platform,
  arch = process.arch,
  target = null,
} = {}) {
  const resolvedTarget = target || engineTarget({ platform, arch }).target;
  const { file, entryFile } = cachePaths(cacheDir, resolvedTarget);
  const entry = readEntry(entryFile);
  if (!entry) return { ok: false, reason: 'cache-missing' };
  if (entry.target && entry.target !== resolvedTarget) return { ok: false, reason: 'cache-target-mismatch' };
  if (entry.platform && entry.platform !== platform) return { ok: false, reason: 'cache-platform-mismatch' };
  if (entry.arch && entry.arch !== arch) return { ok: false, reason: 'cache-arch-mismatch' };
  if (!CHECKSUM_RE.test(String(entry.sha256 || ''))) return { ok: false, reason: 'cache-manifest-invalid' };
  if (!fs.existsSync(file)) return { ok: false, reason: 'cache-missing' };

  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    return { ok: false, reason: `cache-unreadable: ${error.message}` };
  }
  if (Number(entry.size) !== bytes.length) return { ok: false, reason: 'cache-size-mismatch' };
  if (sha256(bytes) !== entry.sha256) return { ok: false, reason: 'cache-checksum-mismatch' };
  return { ok: true, path: file, entry };
}

async function request(url, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer?.unref?.();
  try {
    return await fetchImpl(url, { signal: controller.signal, redirect: 'error' });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options) {
  const response = await request(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function normalizeBase(baseURL) {
  return String(baseURL || DEFAULT_ENGINE_API_BASE).replace(/\/+$/, '');
}

function validEntry(entry, info) {
  if (!entry || typeof entry !== 'object') return 'manifest-entry-invalid';
  if (entry.platform !== info.platform || entry.arch !== info.arch) return 'manifest-target-mismatch';
  if (info.libc && entry.libc && entry.libc !== info.libc) return 'manifest-libc-mismatch';
  if (!CHECKSUM_RE.test(String(entry.sha256 || ''))) return 'manifest-checksum-invalid';
  const size = Number(entry.size);
  if (!Number.isFinite(size) || size <= 0 || size > ENGINE_MAX_BYTES) return 'manifest-size-invalid';
  if (!entry.url) return 'manifest-url-missing';
  return null;
}

function trustedUrl(value, baseURL) {
  let url;
  let base;
  try {
    url = new URL(value, baseURL);
    base = new URL(baseURL);
  } catch {
    return null;
  }
  if (url.origin !== base.origin) return null;
  if (!url.pathname.startsWith('/api/v1/engine/prebuilds/')) return null;
  if (!url.pathname.endsWith('/engine.node')) return null;
  return url;
}

async function writeAtomic(file, bytes) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, bytes, { mode: 0o755 });
    await fsp.rename(tmp, file);
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

const inflight = new Map();

/**
 * Pastikan binary untuk platform ini tersedia di cache.
 *
 * Memakai cache yang masih segar tanpa menyentuh jaringan; bila cache basi,
 * manifest backend diminta lagi dan binary hanya diunduh saat hash berubah.
 * Kegagalan jaringan tidak menghapus cache lama yang masih valid.
 *
 * Panggilan paralel untuk target yang sama (mis. prefetch startup + scheduler)
 * berbagi satu permintaan.
 *
 * @returns {Promise<{ok: boolean, reason?: string, path?: string, entry?: object, source?: string, stale?: boolean}>}
 */
export function ensureEngineBinary(options = {}) {
  const key = [
    options.baseURL || process.env.RYUU_ENGINE_API_BASE || DEFAULT_ENGINE_API_BASE,
    options.cacheDir || engineCacheDir(),
    options.platform || process.platform,
    options.arch || process.arch,
    options.force ? 'force' : 'normal',
  ].join('|');
  if (inflight.has(key)) return inflight.get(key);
  const promise = ensureEngineBinaryCore(options).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

async function ensureEngineBinaryCore({
  baseURL = process.env.RYUU_ENGINE_API_BASE || DEFAULT_ENGINE_API_BASE,
  cacheDir = engineCacheDir(),
  fetchImpl = globalThis.fetch,
  timeoutMs = 4000,
  maxAgeMs = ENGINE_REFRESH_MS,
  force = false,
  logger = null,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const info = engineTarget({ platform, arch });
  const cached = readCachedEngine({ cacheDir, platform, arch, target: info.target });
  const fresh =
    cached.ok &&
    !force &&
    Number.isFinite(cached.entry.fetchedAt) &&
    Date.now() - cached.entry.fetchedAt < maxAgeMs;
  if (fresh) return { ...cached, source: 'cache' };

  const base = normalizeBase(baseURL);
  const query = new URLSearchParams({ platform: info.platform, arch: info.arch });
  if (info.libc) query.set('libc', info.libc);

  const warn = (message, error) => {
    logger?.warn?.(`[monetization] ${message}${error?.message ? `: ${error.message}` : ''}`);
  };

  if (typeof fetchImpl !== 'function') {
    return cached.ok
      ? { ...cached, source: 'cache', stale: true }
      : { ok: false, reason: 'fetch-unavailable' };
  }

  let manifest;
  try {
    manifest = await fetchJson(`${base}/api/v1/engine/prebuilds?${query.toString()}`, { fetchImpl, timeoutMs });
  } catch (error) {
    warn('gagal memilih binary dari backend', error);
    return cached.ok
      ? { ...cached, source: 'cache', stale: true }
      : { ok: false, reason: `manifest-unavailable: ${error.message}` };
  }

  const remote = manifest?.prebuild;
  const invalid = manifest?.success !== true ? 'manifest-rejected' : validEntry(remote, info);
  if (invalid) {
    warn(`manifest engine ditolak (${invalid})`);
    return cached.ok
      ? { ...cached, source: 'cache', stale: true }
      : { ok: false, reason: invalid };
  }

  const { file, entryFile } = cachePaths(cacheDir, info.target);
  const entry = {
    version: manifest.version || null,
    target: remote.target || info.target,
    platform: remote.platform,
    arch: remote.arch,
    ...(remote.libc ? { libc: remote.libc } : {}),
    sha256: remote.sha256,
    size: Number(remote.size),
  };

  // Hash sama: cukup segarkan waktu cek, tidak perlu mengunduh ulang.
  if (cached.ok && cached.entry.sha256 === entry.sha256) {
    const refreshed = { ...cached.entry, ...entry, fetchedAt: Date.now() };
    try {
      await fsp.writeFile(entryFile, `${JSON.stringify(refreshed, null, 2)}\n`, { mode: 0o644 });
    } catch (error) {
      warn('gagal menyegarkan cache engine', error);
    }
    return { ok: true, path: cached.path, entry: refreshed, source: 'cache' };
  }

  const url = trustedUrl(remote.url, base);
  if (!url) {
    warn('URL binary dari backend tidak tepercaya');
    return cached.ok
      ? { ...cached, source: 'cache', stale: true }
      : { ok: false, reason: 'manifest-url-untrusted' };
  }

  let bytes;
  try {
    const response = await request(url.href, { fetchImpl, timeoutMs: Math.max(timeoutMs, 15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    warn('gagal mengunduh binary engine', error);
    return cached.ok
      ? { ...cached, source: 'cache', stale: true }
      : { ok: false, reason: `download-failed: ${error.message}` };
  }

  const rejectDownload = (reason) => (cached.ok ? { ...cached, source: 'cache', stale: true } : { ok: false, reason });
  if (bytes.length > ENGINE_MAX_BYTES) return rejectDownload('binary-too-large');
  if (bytes.length !== entry.size) return rejectDownload('size-mismatch');
  if (sha256(bytes) !== entry.sha256) return rejectDownload('checksum-mismatch');

  try {
    await writeAtomic(file, bytes);
    const stored = { ...entry, fetchedAt: Date.now() };
    await fsp.writeFile(entryFile, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o644 });
    return { ok: true, path: file, entry: stored, source: 'download' };
  } catch (error) {
    warn('gagal menyimpan binary engine', error);
    return { ok: false, reason: `cache-write-failed: ${error.message}` };
  }
}

/** Untuk test: lokasi file cache tanpa menyentuh jaringan. */
export function cachedEnginePath({ cacheDir = engineCacheDir(), platform = process.platform, arch = process.arch } = {}) {
  return cachePaths(cacheDir, engineTarget({ platform, arch }).target).file;
}

/** Platform host yang dipakai backend; berguna untuk logging/tes. */
export function hostEngineTarget() {
  return engineTarget({ platform: process.platform, arch: process.arch });
}
