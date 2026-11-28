import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ensureEngineBinary,
  readCachedEngine,
  engineTarget,
  hostEngineTarget,
} from '../../src/services/engine-binary.js';

const BASE = 'https://restapi.test';

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'ryuu-engine-binary-'));
}

function response(body, { status = 200 } = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(bytes.toString()),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function fixtureManifest(bytes, overrides = {}) {
  const info = hostEngineTarget();
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  return {
    manifest: {
      success: true,
      version: '1.0.0',
      prebuild: {
        platform: info.platform,
        arch: info.arch,
        ...(info.libc ? { libc: info.libc } : {}),
        target: info.target,
        sha256,
        size: bytes.length,
        url: `${BASE}/api/v1/engine/prebuilds/${info.target}/engine.node`,
        ...overrides,
      },
    },
    bytes,
  };
}

function fakeFetch({ manifest, binary, onManifest = null, onBinary = null } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/api/v1/engine/prebuilds?')) {
      onManifest?.();
      if (!manifest) throw new Error('offline');
      return response(manifest);
    }
    onBinary?.();
    if (!binary) throw new Error('offline');
    return response(binary);
  };
  impl.calls = calls;
  return impl;
}

test('mengirim platform/arch ke backend lalu menyimpan binary terverifikasi', async (t) => {
  const cacheDir = await tempDir();
  t.after(() => fsp.rm(cacheDir, { recursive: true, force: true }));
  const bytes = Buffer.from('native-engine-binary');
  const { manifest } = fixtureManifest(bytes);
  const fetchImpl = fakeFetch({ manifest, binary: bytes });

  const result = await ensureEngineBinary({ baseURL: BASE, cacheDir, fetchImpl });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.source, 'download');
  assert.equal(fetchImpl.calls.length, 2);

  const query = new URL(fetchImpl.calls[0]);
  assert.equal(query.pathname, '/api/v1/engine/prebuilds');
  assert.equal(query.searchParams.get('platform'), process.platform);
  assert.equal(query.searchParams.get('arch'), process.arch);

  const cached = readCachedEngine({ cacheDir });
  assert.equal(cached.ok, true);
  assert.equal(cached.entry.version, '1.0.0');
  assert.deepEqual(await fsp.readFile(cached.path), bytes);
});

test('cache segar dipakai tanpa memanggil backend lagi', async (t) => {
  const cacheDir = await tempDir();
  t.after(() => fsp.rm(cacheDir, { recursive: true, force: true }));
  const bytes = Buffer.from('native-engine-binary');
  const { manifest } = fixtureManifest(bytes);
  const fetchImpl = fakeFetch({ manifest, binary: bytes });

  assert.equal((await ensureEngineBinary({ baseURL: BASE, cacheDir, fetchImpl })).ok, true);
  const before = fetchImpl.calls.length;
  const again = await ensureEngineBinary({ baseURL: BASE, cacheDir, fetchImpl });
  assert.equal(again.ok, true);
  assert.equal(again.source, 'cache');
  assert.equal(fetchImpl.calls.length, before, 'cache segar tidak boleh menyentuh jaringan');
});

test('cache basi dipakai sebagai fallback saat backend tidak tersedia', async (t) => {
  const cacheDir = await tempDir();
  t.after(() => fsp.rm(cacheDir, { recursive: true, force: true }));
  const bytes = Buffer.from('native-engine-binary');
  const { manifest } = fixtureManifest(bytes);
  const fetchImpl = fakeFetch({ manifest, binary: bytes });
  assert.equal((await ensureEngineBinary({ baseURL: BASE, cacheDir, fetchImpl })).ok, true);

  const offline = fakeFetch({});
  const stale = await ensureEngineBinary({ baseURL: BASE, cacheDir, fetchImpl: offline, maxAgeMs: 0 });
  assert.equal(stale.ok, true);
  assert.equal(stale.stale, true);
  assert.equal(stale.source, 'cache');
});

test('hash tidak cocok tidak pernah ditulis ke cache', async (t) => {
  const cacheDir = await tempDir();
  t.after(() => fsp.rm(cacheDir, { recursive: true, force: true }));
  const bytes = Buffer.from('native-engine-binary');
  const { manifest } = fixtureManifest(bytes, { sha256: 'a'.repeat(64) });
  const fetchImpl = fakeFetch({ manifest, binary: bytes });

  const result = await ensureEngineBinary({ baseURL: BASE, cacheDir, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'checksum-mismatch');
  assert.equal(readCachedEngine({ cacheDir }).ok, false);
});

test('URL binary dari origin lain ditolak', async (t) => {
  const cacheDir = await tempDir();
  t.after(() => fsp.rm(cacheDir, { recursive: true, force: true }));
  const bytes = Buffer.from('native-engine-binary');
  const { manifest } = fixtureManifest(bytes, {
    url: `https://evil.test/api/v1/engine/prebuilds/${hostEngineTarget().target}/engine.node`,
  });
  const fetchImpl = fakeFetch({ manifest, binary: bytes });

  const result = await ensureEngineBinary({ baseURL: BASE, cacheDir, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'manifest-url-untrusted');
  assert.equal(fetchImpl.calls.length, 1, 'binary dari origin lain tidak boleh diunduh');
});

test('target berbeda tidak memakai cache target lain', async (t) => {
  const cacheDir = await tempDir();
  t.after(() => fsp.rm(cacheDir, { recursive: true, force: true }));
  const bytes = Buffer.from('native-engine-binary');
  const { manifest } = fixtureManifest(bytes);
  const fetchImpl = fakeFetch({ manifest, binary: bytes });
  assert.equal((await ensureEngineBinary({ baseURL: BASE, cacheDir, fetchImpl })).ok, true);

  const other = await ensureEngineBinary({
    baseURL: BASE,
    cacheDir,
    fetchImpl: fakeFetch({}),
    platform: process.platform === 'win32' ? 'linux' : 'win32',
    arch: 'arm64',
    maxAgeMs: 0,
  });
  assert.equal(other.ok, false);
  assert.match(other.reason, /manifest-unavailable/);
});

test('engineTarget memakai suffix musl hanya di Linux musl', () => {
  const host = engineTarget();
  assert.equal(host.target.includes('-musl'), host.libc === 'musl');
  assert.equal(engineTarget({ platform: 'darwin', arch: 'arm64' }).libc, null);
  assert.equal(engineTarget({ platform: 'darwin', arch: 'arm64' }).target, 'darwin-arm64');
});
