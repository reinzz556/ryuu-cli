import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { Writable } from 'node:stream';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { RyuuError } from '../../../../src/utils/errors.js';

/**
 * Dependency-free streaming ZIP writer.
 *
 * Only Node built-ins are used: each file is deflated through a stream straight
 * into the archive, so a 1 GB project never sits in memory. Sizes and CRC32 are
 * carried by data descriptors (general-purpose bit 3), which is what allows the
 * writer to stream without a second pass over every entry.
 */

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const MAX32 = 0xffffffff;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

/** Running CRC32 so entries stream without buffering. */
export function createCrc32() {
  let crc = -1;
  return {
    update(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
      return this;
    },
    digest() {
      return (crc ^ -1) >>> 0;
    },
  };
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

/** Normalise an entry name to forward slashes with no absolute or parent parts. */
export function safeEntryName(name) {
  const normalised = String(name).replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalised.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..') || /^[A-Za-z]:/.test(normalised)) {
    throw new RyuuError(`Nama entri arsip tidak aman: ${name}`, { code: 'ZIP_UNSAFE' });
  }
  return parts.join('/');
}

export class ZipWriter {
  constructor({ file, compressionLevel = 6 } = {}) {
    this.file = file;
    this.level = Math.min(Math.max(Number(compressionLevel ?? 6), 0), 9);
    this.entries = [];
    this.offset = 0;
    this.stream = null;
  }

  async open() {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    this.stream = fs.createWriteStream(this.file, { mode: 0o600 });
    return this;
  }

  async #write(buffer) {
    this.offset += buffer.length;
    if (!this.stream.write(buffer)) await once(this.stream, 'drain');
  }

  /** Stream one local file into the archive under `entryName`. */
  async addFile(entryName, absPath, { signal = null } = {}) {
    const name = Buffer.from(safeEntryName(entryName), 'utf8');
    const stat = await fsp.stat(absPath);
    const { time, date } = dosDateTime(stat.mtime);
    const method = this.level === 0 || stat.size === 0 ? 0 : 8;
    const headerOffset = this.offset;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(SIG_LOCAL, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0808, 6); // data descriptor + UTF-8 names
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(0, 14); // crc32 (in descriptor)
    header.writeUInt32LE(0, 18); // compressed size (in descriptor)
    header.writeUInt32LE(0, 22); // uncompressed size (in descriptor)
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    await this.#write(Buffer.concat([header, name]));

    const crc = createCrc32();
    let uncompressed = 0;
    let compressed = 0;
    const source = fs.createReadStream(absPath);
    // CRC32 and the uncompressed size are measured before deflate; the
    // compressed size is measured on the deflated bytes.
    const meter = async function* (stream) {
      for await (const chunk of stream) {
        if (signal?.aborted) throw new RyuuError('Backup dibatalkan.', { code: 'CANCELLED' });
        crc.update(chunk);
        uncompressed += chunk.length;
        yield chunk;
      }
    };
    const sink = new Writable({
      write: (chunk, _encoding, callback) => {
        compressed += chunk.length;
        this.#write(chunk).then(() => callback(), (error) => callback(error));
      },
    });
    if (method === 8) {
      await pipeline(source, meter, zlib.createDeflateRaw({ level: this.level }), sink);
    } else {
      await pipeline(source, meter, sink);
    }
    if (compressed > MAX32 || uncompressed > MAX32) {
      throw new RyuuError('Arsip melebihi 4 GB: ZIP64 tidak didukung. Pecah backup menjadi beberapa bagian.', {
        code: 'ZIP_TOO_LARGE',
      });
    }

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(SIG_DESCRIPTOR, 0);
    descriptor.writeUInt32LE(crc.digest(), 4);
    descriptor.writeUInt32LE(compressed, 8);
    descriptor.writeUInt32LE(uncompressed, 12);
    await this.#write(descriptor);

    this.entries.push({
      name: name.toString('utf8'),
      method,
      crc32: crc.digest(),
      compressedSize: compressed,
      uncompressedSize: uncompressed,
      offset: headerOffset,
      time,
      date,
    });
    return { name: name.toString('utf8'), size: uncompressed, storedSize: compressed };
  }

  async close() {
    const centralStart = this.offset;
    for (const entry of this.entries) {
      const name = Buffer.from(entry.name, 'utf8');
      const record = Buffer.alloc(46);
      record.writeUInt32LE(SIG_CENTRAL, 0);
      record.writeUInt16LE(20, 4); // version made by
      record.writeUInt16LE(20, 6); // version needed
      record.writeUInt16LE(0x0808, 8);
      record.writeUInt16LE(entry.method, 10);
      record.writeUInt16LE(entry.time, 12);
      record.writeUInt16LE(entry.date, 14);
      record.writeUInt32LE(entry.crc32, 16);
      record.writeUInt32LE(entry.compressedSize, 20);
      record.writeUInt32LE(entry.uncompressedSize, 24);
      record.writeUInt16LE(name.length, 28);
      record.writeUInt16LE(0, 30); // extra
      record.writeUInt16LE(0, 32); // comment
      record.writeUInt16LE(0, 34); // disk
      record.writeUInt16LE(0, 36); // internal attrs
      record.writeUInt32LE(0, 38); // external attrs
      record.writeUInt32LE(entry.offset, 42);
      await this.#write(Buffer.concat([record, name]));
    }
    const centralSize = this.offset - centralStart;
    if (this.offset > MAX32) {
      throw new RyuuError('Arsip melewati 4 GB: ZIP64 tidak didukung.', { code: 'ZIP_TOO_LARGE' });
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralStart, 16);
    eocd.writeUInt16LE(0, 20);
    await this.#write(eocd);
    this.stream.end();
    await once(this.stream, 'finish');
    return { file: this.file, bytes: this.offset, fileCount: this.entries.length };
  }
}

export { SIG_LOCAL, SIG_CENTRAL, SIG_EOCD, MAX32 };
