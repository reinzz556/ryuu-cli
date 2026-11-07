import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { RyuuError } from '../../../../src/utils/errors.js';
import { createCrc32 } from './zip-writer.js';

/**
 * Streaming ZIP reader with Zip Slip protection.
 *
 * The central directory is parsed once (it is small), then each entry is
 * inflated straight from a bounded slice of the archive into its destination
 * file. Every path is re-validated against the extraction root, and CRC32 is
 * checked, so a corrupted or hostile archive fails before it can write outside
 * the destination directory.
 */

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function zipError(message, extra = {}) {
  return new RyuuError(message, { code: 'ZIP_INVALID', ...extra });
}

/** Reject absolute paths, `..` segments and drive letters (Zip Slip). */
export function assertSafeEntryName(name) {
  const raw = String(name).replace(/\\/g, '/');
  if (!raw || raw.endsWith('/')) return null; // directory entry
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    throw zipError(`Arsip berisi path absolut dan ditolak: ${raw}`);
  }
  const segments = raw.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw zipError(`Arsip berisi path traversal dan ditolak: ${raw}`);
  }
  const clean = segments.filter((segment) => segment && segment !== '.').join('/');
  if (!clean) return null;
  return clean;
}

/** Resolve an entry against the extraction root, refusing any escape. */
export function resolveInside(root, entryName) {
  const clean = assertSafeEntryName(entryName);
  if (!clean) return null;
  const target = path.resolve(root, clean);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw zipError(`Entri arsip menulis di luar direktori tujuan: ${entryName}`);
  }
  return { relative: relative.split(path.sep).join('/'), target };
}

async function readEocd(handle, size) {
  const tailLength = Math.min(size, 66 * 1024);
  const buffer = Buffer.alloc(tailLength);
  await handle.read(buffer, 0, tailLength, size - tailLength);
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) {
      return {
        entryCount: buffer.readUInt16LE(i + 10),
        centralSize: buffer.readUInt32LE(i + 12),
        centralOffset: buffer.readUInt32LE(i + 16),
      };
    }
  }
  throw zipError('Arsip bukan ZIP yang valid (end of central directory tidak ditemukan).');
}

async function readCentralDirectory(handle, eocd) {
  if (eocd.centralSize === 0) return [];
  const buffer = Buffer.alloc(eocd.centralSize);
  await handle.read(buffer, 0, eocd.centralSize, eocd.centralOffset);
  const entries = [];
  let offset = 0;
  while (offset + 46 <= buffer.length && buffer.readUInt32LE(offset) === SIG_CENTRAL) {
    const flags = buffer.readUInt16LE(offset + 8);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    entries.push({
      name,
      flags,
      method: buffer.readUInt16LE(offset + 10),
      crc32: buffer.readUInt32LE(offset + 16),
      compressedSize: buffer.readUInt32LE(offset + 20),
      uncompressedSize: buffer.readUInt32LE(offset + 24),
      localOffset: buffer.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Read an archive's table of contents without extracting anything. */
export async function listZipEntries(zipPath) {
  let handle;
  try {
    handle = await fsp.open(zipPath, 'r');
  } catch (error) {
    throw zipError(`Arsip tidak dapat dibuka: ${zipPath} (${error.message})`);
  }
  try {
    const { size } = await handle.stat();
    if (size < 22) throw zipError('Arsip terlalu kecil untuk menjadi ZIP yang valid.');
    const eocd = await readEocd(handle, size);
    return await readCentralDirectory(handle, eocd);
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Extract `zipPath` into `destination`.
 *
 * `overwrite: false` refuses to replace an existing file instead of silently
 * clobbering it. A symlink at the target path is always refused, even with
 * overwrite, because writing through it would escape the destination.
 */
export async function extractZip({
  zipPath,
  destination,
  overwrite = false,
  entries: only = null,
  maxTotalBytes = 8 * 1024 * 1024 * 1024,
  onProgress = null,
  signal = null,
} = {}) {
  const root = path.resolve(destination);
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  const handle = await fsp.open(zipPath, 'r');
  const written = [];
  let totalBytes = 0;
  try {
    const { size } = await handle.stat();
    const eocd = await readEocd(handle, size);
    const entries = await readCentralDirectory(handle, eocd);
    const wanted = only ? new Set(only) : null;
    for (const entry of entries) {
      if (signal?.aborted) throw new RyuuError('Restore dibatalkan.', { code: 'CANCELLED' });
      if (entry.flags & 0x1) throw zipError('Arsip terenkripsi tidak didukung.');
      if (entry.method !== 0 && entry.method !== 8) {
        throw zipError(`Metode kompresi ${entry.method} tidak didukung pada entri ${entry.name}.`);
      }
      const resolved = resolveInside(root, entry.name);
      if (!resolved) continue;
      if (wanted && !wanted.has(resolved.relative)) continue;

      // A symlink anywhere on the path would let the write escape the root.
      const parent = path.dirname(resolved.target);
      await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
      try {
        const existing = await fsp.lstat(resolved.target);
        if (existing.isSymbolicLink()) {
          throw zipError(`Tujuan ekstraksi adalah symlink dan ditolak: ${resolved.relative}`);
        }
        if (existing.isDirectory()) {
          throw zipError(`Tujuan ekstraksi adalah direktori, bukan file: ${resolved.relative}`);
        }
        if (!overwrite) {
          throw new RyuuError(
            `File sudah ada dan tidak ditimpa: ${resolved.relative}. Jalankan ulang dengan overwrite=true bila memang ingin menggantinya.`,
            { code: 'RESTORE_EXISTS' },
          );
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      const headerBuffer = Buffer.alloc(30);
      await handle.read(headerBuffer, 0, 30, entry.localOffset);
      if (headerBuffer.readUInt32LE(0) !== SIG_LOCAL) {
        throw zipError(`Local header tidak valid pada entri ${entry.name}.`);
      }
      const nameLength = headerBuffer.readUInt16LE(26);
      const extraLength = headerBuffer.readUInt16LE(28);
      const dataStart = entry.localOffset + 30 + nameLength + extraLength;
      if (entry.compressedSize === 0) {
        await fsp.writeFile(resolved.target, Buffer.alloc(0), { mode: 0o600 });
        written.push({ path: resolved.relative, bytes: 0 });
        continue;
      }
      if (dataStart + entry.compressedSize > size) {
        throw zipError(`Entri ${entry.name} melewati akhir arsip (arsip rusak).`);
      }
      const source = handle.createReadStream({ start: dataStart, end: dataStart + entry.compressedSize - 1, autoClose: false });
      const crc = createCrc32();
      const sink = fs.createWriteStream(resolved.target, { mode: 0o600 });
      const meter = async function* meter(stream) {
        for await (const chunk of stream) {
          crc.update(chunk);
          totalBytes += chunk.length;
          if (totalBytes > maxTotalBytes) {
            throw zipError('Ukuran hasil ekstraksi melebihi batas keamanan (8 GB).');
          }
          if (onProgress) onProgress({ path: resolved.relative, loaded: totalBytes });
          yield chunk;
        }
      };
      if (entry.method === 8) {
        await pipeline(source, zlib.createInflateRaw(), meter, sink);
      } else {
        await pipeline(source, meter, sink);
      }
      if (crc.digest() !== entry.crc32) {
        await fsp.rm(resolved.target, { force: true }).catch(() => {});
        throw zipError(`CRC arsip tidak cocok pada entri ${entry.name} (arsip rusak).`);
      }
      written.push({ path: resolved.relative, bytes: entry.uncompressedSize });
    }
    return { destination: root, files: written, fileCount: written.length, bytes: totalBytes };
  } finally {
    await handle.close().catch(() => {});
  }
}
