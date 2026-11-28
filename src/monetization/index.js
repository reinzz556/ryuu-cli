/**
 * Loader modul monetisasi.
 *
 * Urutan:
 *   1. Prebuild yang cocok di dalam package `dist/monetization/prebuilds`
 *      (atau `../ryuu-build/dist/monetization` saat development) —
 *      diverifikasi SHA-256 dan opsional tanda tangan Ed25519. Logika engine
 *      ada di dalam binary, bukan source JavaScript.
 *   2. Cache binary hasil pemilihan backend (`<config>/engine/<target>`),
 *      dipakai bila package tidak membawa prebuild untuk platform ini.
 *
 * Artifact yang ada tetapi gagal verifikasi TIDAK di-fallback ke source:
 * kegagalan integritas mematikan iklan (fail closed) dan dilaporkan ke log.
 * Ini bukan klaim anti-reverse-engineering; tujuannya mendeteksi modifikasi
 * tidak sah pada distribusi resmi.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { attachNetwork } from './network.js';
import { ensureEngineBinary, readCachedEngine } from '../services/engine-binary.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Pipeline build hidup di project terpisah `agents/ryuu-build`, di luar folder
// CLI. Package hasil publish membawa artifact di `dist/` lokal; checkout
// development membaca artifact/source dari folder build tersebut.
export const BUILD_ROOT = path.join(__dirname, 'engine');
const LOCAL_ARTIFACT_DIR = path.join(__dirname, 'engine', 'dist', 'monetization');
const BUILD_ARTIFACT_DIR = path.join(BUILD_ROOT, 'dist', 'monetization');
export const ARTIFACT_DIR = fs.existsSync(path.join(LOCAL_ARTIFACT_DIR, 'manifest.json'))
  ? LOCAL_ARTIFACT_DIR
  : BUILD_ARTIFACT_DIR;
export const ARTIFACT_FILE = path.join(ARTIFACT_DIR, 'engine.node');
export const MANIFEST_FILE = path.join(ARTIFACT_DIR, 'manifest.json');
export const SOURCE_FILE = path.join(BUILD_ROOT, 'monetization-src', 'engine.cjs');

export class MonetizationIntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MonetizationIntegrityError';
    this.code = 'MONETIZATION_INTEGRITY';
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function canonicalManifest(manifest) {
  const lines = [
    `version=${manifest.version || ''}`,
    `artifact=${manifest.artifact || ''}`,
    `sha256=${manifest.sha256 || ''}`,
    `size=${manifest.size ?? ''}`,
    `sourceSha256=${manifest.sourceSha256 || ''}`,
  ];
  // Daftar prebuild ikut ditandatangani supaya entry tidak bisa ditukar.
  if (Array.isArray(manifest.prebuilds)) {
    lines.push(`prebuilds=${manifest.prebuilds.map((entry) => `${entry.file}:${entry.sha256}:${entry.size}`).join(',')}`);
  }
  return lines.join('\n');
}

/** glibc vs musl pada Linux; null di platform lain. */
function linuxLibc() {
  if (process.platform !== 'linux') return null;
  try {
    const report = process.report?.getReport?.();
    if (report?.header?.glibcVersionRuntime) return 'glibc';
  } catch {
    // laporan runtime tidak tersedia
  }
  return 'musl';
}

function resolveInside(base, relative) {
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) return null;
  return target;
}

/** Prebuild yang cocok dengan platform/arsitektur (dan libc) proses ini. */
export function selectPrebuild(manifest = null, { platform = process.platform, arch = process.arch, libc = linuxLibc() } = {}) {
  const entries = Array.isArray(manifest?.prebuilds) ? manifest.prebuilds : [];
  const matching = entries.filter(
    (entry) => entry && entry.platform === platform && entry.arch === arch && (!entry.libc || !libc || entry.libc === libc),
  );
  return matching.find((entry) => entry.libc && libc && entry.libc === libc) || matching[0] || null;
}

function trustedPublicKey() {
  if (process.env.RYUU_ADS_PUBLIC_KEY) return process.env.RYUU_ADS_PUBLIC_KEY;
  const file = path.join(__dirname, 'trusted-key.pub');
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Verifikasi artifact tanpa memuatnya.
 *
 * `file`/`manifestFile` bisa diarahkan ke salinan (dipakai test integritas):
 * menulis ulang file `.node` yang sudah dimuat akan merusak mapping addon di
 * memori, jadi artifact asli tidak boleh ditimpa untuk pengujian.
 *
 * @returns {{ok: boolean, reason: string, manifest?: object, path?: string}}
 */
export function verifyMonetizationArtifact({ file = null, dir = ARTIFACT_DIR, manifestFile = null } = {}) {
  const manifestPath = manifestFile || path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, reason: 'artifact-missing' };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return { ok: false, reason: `manifest-invalid: ${error.message}` };
  }

  if (manifest.signature) {
    const key = trustedPublicKey();
    if (!key) {
      return { ok: false, reason: 'signature-present-without-trusted-key' };
    }
    try {
      const valid = crypto.verify(
        null,
        Buffer.from(canonicalManifest(manifest), 'utf8'),
        key,
        Buffer.from(String(manifest.signature), 'base64'),
      );
      if (!valid) return { ok: false, reason: 'signature-invalid' };
    } catch (error) {
      return { ok: false, reason: `signature-error: ${error.message}` };
    }
  }

  const check = (target, expected) => {
    const bytes = fs.readFileSync(target);
    const digest = sha256(bytes);
    if (!/^[a-f0-9]{64}$/.test(String(expected.sha256 || '')) || digest !== expected.sha256) {
      return { ok: false, reason: 'checksum-mismatch' };
    }
    if (Number(expected.size) !== bytes.length) {
      return { ok: false, reason: 'size-mismatch' };
    }
    return { ok: true, reason: 'ok', manifest, path: target };
  };

  // Verifikasi file eksplisit (test integritas memakai salinan artifact).
  if (file) {
    if (!fs.existsSync(file)) return { ok: false, reason: 'artifact-missing' };
    const expected =
      manifest.artifact === path.basename(file)
        ? { sha256: manifest.sha256, size: manifest.size }
        : (manifest.prebuilds || []).find((entry) => entry && path.basename(entry.file) === path.basename(file));
    if (!expected) return { ok: false, reason: 'manifest-artifact-mismatch' };
    return check(file, expected);
  }

  // Prebuild untuk platform/arsitektur ini lebih diutamakan daripada artifact
  // host legacy, sehingga paket multi-platform memuat binary yang tepat.
  const prebuild = selectPrebuild(manifest);
  if (prebuild) {
    const target = resolveInside(dir, prebuild.file);
    if (!target) return { ok: false, reason: 'prebuild-path-invalid' };
    if (!fs.existsSync(target)) return { ok: false, reason: `prebuild-missing: ${prebuild.file}` };
    const result = check(target, prebuild);
    return result.ok ? { ...result, prebuild } : result;
  }
  if (Array.isArray(manifest.prebuilds) && manifest.prebuilds.length > 0) {
    return { ok: false, reason: `no-prebuild-for-platform: ${process.platform}-${process.arch}` };
  }

  // Manifest lama (satu artifact) tetap didukung selama platformnya cocok.
  const legacyFile = path.join(dir, 'engine.node');
  if (!fs.existsSync(legacyFile)) return { ok: false, reason: 'artifact-missing' };
  if (manifest.artifact !== path.basename(legacyFile)) {
    return { ok: false, reason: 'manifest-artifact-mismatch' };
  }
  if (manifest.platform && manifest.platform !== process.platform) {
    return { ok: false, reason: `platform-mismatch: ${manifest.platform} != ${process.platform}` };
  }
  if (manifest.arch && manifest.arch !== process.arch) {
    return { ok: false, reason: `arch-mismatch: ${manifest.arch} != ${process.arch}` };
  }
  return check(legacyFile, manifest);
}

let cached = null;

/**
 * @param {{ logger?: object, force?: boolean }} [options]
 * @returns {{ engine: object, mode: 'artifact'|'source', manifest: object|null }}
 */
export function loadMonetizationEngine({ logger = null, force = false } = {}) {
  if (cached && !force) return cached;

  const required = process.env.RYUU_ADS_REQUIRE_ARTIFACT === '1';
  const verified = verifyMonetizationArtifact();

  if (verified.ok) {
    let engine;
    try {
      // Artifact adalah addon N-API yang sudah lolos checksum. Kegagalan muat
      // (ABI/arsitektur salah) adalah kegagalan integritas: jangan pernah
      // diam-diam jatuh ke source.
      engine = attachNetwork(require(verified.path));
    } catch (error) {
      throw new MonetizationIntegrityError(`Modul monetisasi gagal dimuat: ${error.message}.`);
    }
    cached = {
      engine,
      mode: 'artifact',
      manifest: verified.manifest,
      integrity: 'verified',
    };
    return cached;
  }

  // Package mungkin tidak membawa prebuild untuk platform ini (mis. hanya
  // sebagian platform yang dipaketkan). Binary yang cocok bisa diambil dari
  // cache unduhan backend, dengan verifikasi hash yang sama.
  const fetchable =
    verified.reason === 'artifact-missing' || verified.reason.startsWith('no-prebuild-for-platform');
  if (fetchable) {
    const fromCache = readCachedEngine();
    if (fromCache.ok) {
      let engine;
      try {
        engine = attachNetwork(require(fromCache.path));
      } catch (error) {
        throw new MonetizationIntegrityError(`Modul monetisasi gagal dimuat: ${error.message}.`);
      }
      cached = {
        engine,
        mode: 'artifact',
        source: 'backend',
        manifest: fromCache.entry,
        integrity: 'verified',
      };
      return cached;
    }
  }

  if (required) {
    throw new MonetizationIntegrityError(`Modul monetisasi tidak lolos verifikasi: ${verified.reason}.`);
  }

  if (!fetchable) {
    // Artifact ada tetapi rusak/dimodifikasi: jangan pernah memakai source
    // sebagai pengganti diam-diam.
    throw new MonetizationIntegrityError(`Modul monetisasi tidak lolos verifikasi: ${verified.reason}.`);
  }
  return cached;
}

/**
 * Muat engine, mengunduh binary yang cocok dari backend bila perlu.
 *
 * Loader sinkron tetap dipakai lebih dulu (bundled/cache); hanya bila tidak
 * ada binary sama sekali manifest backend diminta. Kegagalan unduh tidak
 * melempar: scheduler akan melewati iklan untuk sesi ini.
 *
 * @param {{ logger?: object, force?: boolean, baseURL?: string, cacheDir?: string, fetchImpl?: Function }} [options]
 */
export async function prepareMonetizationEngine({ logger = null, force = false, ...downloadOptions } = {}) {
  let loaded = null;
  try {
    loaded = loadMonetizationEngine({ logger, force });
  } catch (error) {
    // Mode wajib-artifact menolak lebih awal saat belum ada binary. Di sini
    // unduhan terverifikasi masih boleh memenuhinya; kegagalan lain (artifact
    // rusak/dimodifikasi) tetap fail closed.
    const partial = error instanceof MonetizationIntegrityError &&
      /artifact-missing|no-prebuild-for-platform/.test(error.message);
    if (!partial) throw error;
  }
  if (loaded?.engine) return loaded;

  const result = await ensureEngineBinary({ logger, force, ...downloadOptions });
  if (!result.ok) {
    if (process.env.RYUU_ADS_REQUIRE_ARTIFACT === '1') {
      throw new MonetizationIntegrityError(
        `Modul monetisasi tidak lolos verifikasi: ${result.reason || 'artifact-missing'}.`,
      );
    }
    return null;
  }
  return loadMonetizationEngine({ logger, force: true });
}
