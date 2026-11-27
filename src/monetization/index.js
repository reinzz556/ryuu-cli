/**
 * Loader modul monetisasi.
 *
 * Urutan:
 *   1. Compiled artifact `dist/monetization/engine.cjs` di dalam package
 *      (dibundel saat publish), atau `../ryuu-build/dist/monetization` saat
 *      development — diverifikasi SHA-256 dan opsional tanda tangan Ed25519.
 *   2. Source development `../ryuu-build/monetization-src/engine.cjs` — hanya
 *      bila artifact belum dibangun dan `RYUU_ADS_REQUIRE_ARTIFACT !== '1'`.
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
export const ARTIFACT_FILE = path.join(ARTIFACT_DIR, 'engine.cjs');
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
  return [
    `version=${manifest.version || ''}`,
    `artifact=${manifest.artifact || ''}`,
    `sha256=${manifest.sha256 || ''}`,
    `size=${manifest.size ?? ''}`,
    `sourceSha256=${manifest.sourceSha256 || ''}`,
  ].join('\n');
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
 * @returns {{ok: boolean, reason: string, manifest?: object, path?: string}}
 */
export function verifyMonetizationArtifact() {
  if (!fs.existsSync(ARTIFACT_FILE) || !fs.existsSync(MANIFEST_FILE)) {
    return { ok: false, reason: 'artifact-missing' };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  } catch (error) {
    return { ok: false, reason: `manifest-invalid: ${error.message}` };
  }

  if (!manifest || manifest.artifact !== path.basename(ARTIFACT_FILE)) {
    return { ok: false, reason: 'manifest-artifact-mismatch' };
  }

  const bytes = fs.readFileSync(ARTIFACT_FILE);
  const digest = sha256(bytes);
  if (!/^[a-f0-9]{64}$/.test(String(manifest.sha256 || '')) || digest !== manifest.sha256) {
    return { ok: false, reason: 'checksum-mismatch' };
  }
  if (Number(manifest.size) !== bytes.length) {
    return { ok: false, reason: 'size-mismatch' };
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

  return { ok: true, reason: 'ok', manifest, path: ARTIFACT_FILE };
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
    const engine = require(verified.path);
    cached = {
      engine,
      mode: 'artifact',
      manifest: verified.manifest,
      integrity: 'verified',
    };
    return cached;
  }

  if (required) {
    throw new MonetizationIntegrityError(`Modul monetisasi tidak lolos verifikasi: ${verified.reason}.`);
  }

  if (verified.reason !== 'artifact-missing') {
    // Artifact ada tetapi rusak/dimodifikasi: jangan pernah memakai source
    // sebagai pengganti diam-diam.
    throw new MonetizationIntegrityError(`Modul monetisasi tidak lolos verifikasi: ${verified.reason}.`);
  }
  return cached;
}
