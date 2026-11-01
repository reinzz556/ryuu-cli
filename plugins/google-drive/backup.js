import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { RyuuError } from '../../src/utils/errors.js';
import { ZipWriter } from './zip-writer.js';
import { extractZip, listZipEntries } from './zip-reader.js';

/**
 * Backup and restore engine for the Google Drive plugin.
 *
 * Backups are streamed into a temporary ZIP (never fully buffered), uploaded
 * with a resumable request, and the temporary file is always removed. Restore
 * downloads to a temporary file, validates the archive, then extracts with Zip
 * Slip protection.
 */

const BACKUP_ERROR = 'DRIVE_BACKUP';

/** Patterns that must never be archived silently. */
export const HARD_EXCLUDES = Object.freeze([
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa*',
  'id_ed25519*',
  'credentials.json',
  'service-account*.json',
  'credentials.enc',
]);

/** Turn a pattern list into matchers; supports `*`, `?`, `**` and bare names. */
export function compilePatterns(patterns = []) {
  return patterns
    .map((pattern) => String(pattern || '').trim())
    .filter(Boolean)
    .map((pattern) => {
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      const body = escaped.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
      return { pattern, regex: new RegExp(`^${body}$`) };
    });
}

/** True when `relPath` (posix style) or any of its segments matches a pattern. */
export function isExcluded(relPath, matchers) {
  const candidates = [relPath, ...relPath.split('/')];
  return matchers.some(({ regex }) => candidates.some((candidate) => regex.test(candidate)));
}

/**
 * Walk `root` and return the files that may be archived, with their sizes.
 * Symlinks are not followed: a backup must not silently pull in /etc.
 */
export async function collectFiles({ root, includePatterns = [], excludePatterns = [], maxFiles = 20000, signal = null, onProgress = null }) {
  const matchers = compilePatterns([...excludePatterns, ...HARD_EXCLUDES]);
  const includes = includePatterns.length > 0 ? compilePatterns(includePatterns) : null;
  const files = [];
  let totalBytes = 0;
  let skipped = 0;

  const walk = async (dir) => {
    if (signal?.aborted) throw new RyuuError('Backup dibatalkan.', { code: 'CANCELLED' });
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        throw new RyuuError(
          `Backup dibatasi ${maxFiles} file. Persempit sourcePath atau tambah excludePatterns.`,
          { code: BACKUP_ERROR },
        );
      }
      const absPath = path.join(dir, entry.name);
      const relPath = path.relative(root, absPath).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        skipped += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (isExcluded(`${relPath}/`, matchers) || isExcluded(relPath, matchers)) {
          skipped += 1;
          continue;
        }
        await walk(absPath);
        continue;
      }
      if (!entry.isFile()) {
        skipped += 1;
        continue;
      }
      if (isExcluded(relPath, matchers)) {
        skipped += 1;
        continue;
      }
      if (includes && !includes.some(({ regex }) => regex.test(relPath))) {
        skipped += 1;
        continue;
      }
      const stat = await fsp.stat(absPath);
      files.push({ absPath, relPath, size: stat.size, mtime: stat.mtime });
      totalBytes += stat.size;
      if (onProgress) onProgress({ files: files.length, bytes: totalBytes, current: relPath });
    }
  };

  const stat = await fsp.stat(root).catch((error) => {
    if (error.code === 'ENOENT') throw new RyuuError(`Direktori sumber tidak ditemukan: ${root}`, { code: 'DRIVE_LOCAL' });
    throw new RyuuError(`Direktori sumber tidak dapat dibaca: ${root} (${error.message})`, { code: 'DRIVE_LOCAL' });
  });
  if (!stat.isDirectory()) throw new RyuuError(`Sumber backup bukan direktori: ${root}`, { code: 'DRIVE_LOCAL' });
  await walk(root);
  return { root, files, totalBytes, skipped, excludedPatterns: [...excludePatterns, ...HARD_EXCLUDES] };
}

/** Default archive name: `<name>-backup-YYYYMMDD-HHmmss.zip`. */
export function defaultArchiveName(baseName = 'project', date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const safe = String(baseName || 'project').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  return `${safe}-backup-${stamp}.zip`;
}

/** Create the ZIP in a temporary directory and return its path and stats. */
export async function createArchive({ files, archivePath, compressionLevel = 6, signal = null }) {
  const writer = new ZipWriter({ file: archivePath, compressionLevel });
  await writer.open();
  try {
    for (const file of files) {
      await writer.addFile(file.relPath, file.absPath, { signal });
    }
    return await writer.close();
  } catch (error) {
    await fsp.rm(archivePath, { force: true }).catch(() => {});
    throw error instanceof RyuuError
      ? error
      : new RyuuError(`Gagal membuat arsip backup: ${error.message}`, { code: BACKUP_ERROR });
  }
}

/** Temporary scratch directory owned by the plugin. */
export async function makeTempDir(label = 'drive') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `ryuu-${label}-`));
  return dir;
}

function formatBackupName(name) {
  return String(name || '').trim();
}

/**
 * Full backup: collect → archive → upload → cleanup.
 * Nothing is deleted from the source directory, and old backups are kept.
 */
export async function backupToDrive({
  drive,
  sourceRoot,
  destinationFolderId,
  archiveName = null,
  excludePatterns = [],
  includePatterns = [],
  compressionLevel = 6,
  maxUploadSize = 0,
  signal = null,
  onProgress = null,
  logger = null,
}) {
  const collected = await collectFiles({ root: sourceRoot, includePatterns, excludePatterns, signal, onProgress });
  if (collected.files.length === 0) {
    throw new RyuuError('Tidak ada file yang bisa dibackup setelah exclusion diterapkan.', { code: BACKUP_ERROR });
  }
  if (maxUploadSize > 0 && collected.totalBytes > maxUploadSize) {
    throw new RyuuError(
      `Ukuran backup ${collected.totalBytes} byte melebihi maxUploadSize ${maxUploadSize} byte. Tambah excludePatterns atau naikkan maxUploadSize.`,
      { code: BACKUP_ERROR },
    );
  }
  const folder = await drive.assertFolder({ folderId: destinationFolderId, label: 'Folder tujuan backup' });
  const name = formatBackupName(archiveName) || defaultArchiveName(path.basename(sourceRoot));
  const tempDir = await makeTempDir('backup');
  const archivePath = path.join(tempDir, name.endsWith('.zip') ? name : `${name}.zip`);
  try {
    const archive = await createArchive({ files: collected.files, archivePath, compressionLevel, signal });
    onProgress?.({ stage: 'uploading', archive: path.basename(archivePath) });
    const uploaded = await drive.uploadFile({
      filePath: archivePath,
      fileName: path.basename(archivePath),
      folderId: folder.id,
      mimeType: 'application/zip',
      onProgress: (event) => onProgress?.({ stage: 'upload', ...event }),
    });
    logger?.info('drive backup uploaded', { fileId: uploaded.id, bytes: uploaded.size });
    return {
      archiveName: path.basename(archivePath),
      fileId: uploaded.id,
      size: uploaded.size ?? archive.bytes,
      sourcePath: sourceRoot,
      destinationFolderId: folder.id,
      destinationFolderName: folder.name || null,
      webViewLink: uploaded.webViewLink,
      fileCount: collected.files.length,
      excludedPatterns: collected.excludedPatterns,
      skipped: collected.skipped,
      createdAt: new Date().toISOString(),
      status: 'berhasil',
    };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** List ZIP archives that look like Ryuu backups inside a folder. */
export async function listBackups({ drive, folderId = 'root', pageSize = 50, pageToken = null }) {
  const result = await drive.search({
    query: "mimeType = 'application/zip'",
    folderId,
    pageSize,
    pageToken,
    orderBy: 'modifiedTime desc',
  });
  return { ...result, backups: result.files.filter((file) => /\.zip$/i.test(file.name)) };
}

/**
 * Restore: download → validate → extract. The archive is inspected before any
 * file is written, and an existing target file is only replaced with overwrite.
 */
export async function restoreFromDrive({
  drive,
  fileId,
  destinationRoot,
  overwrite = false,
  signal = null,
  onProgress = null,
  logger = null,
}) {
  const tempDir = await makeTempDir('restore');
  const archivePath = path.join(tempDir, `restore-${randomBytes(4).toString('hex')}.zip`);
  try {
    const downloaded = await drive.downloadFile({
      fileId,
      destination: archivePath,
      onProgress: (event) => onProgress?.({ stage: 'download', ...event }),
    });
    const entries = await listZipEntries(archivePath);
    if (entries.length === 0) {
      throw new RyuuError('Arsip backup kosong atau tidak valid.', { code: 'ZIP_INVALID' });
    }
    onProgress?.({ stage: 'extract', entries: entries.length });
    const extracted = await extractZip({ zipPath: archivePath, destination: destinationRoot, overwrite, signal, onProgress });
    logger?.info('drive restore extracted', { fileId, files: extracted.fileCount });
    return {
      fileId,
      archiveName: downloaded.name,
      destinationPath: extracted.destination,
      overwritten: Boolean(overwrite),
      fileCount: extracted.fileCount,
      bytes: extracted.bytes,
      archiveEntries: entries.length,
      files: extracted.files.slice(0, 200),
      restoredAt: new Date().toISOString(),
      status: 'berhasil',
    };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Remove one backup archive after an explicit confirmation upstream. */
export async function deleteBackup({ drive, fileId }) {
  const meta = await drive.getMetadata({ fileId });
  if (!/\.zip$/i.test(meta.name || '')) {
    throw new RyuuError(`File ${meta.name || fileId} bukan arsip backup (.zip), penghapusan dibatalkan.`, {
      code: BACKUP_ERROR,
    });
  }
  await drive.remove({ fileId });
  return { fileId, name: meta.name, size: meta.size, deleted: true, deletedAt: new Date().toISOString() };
}
