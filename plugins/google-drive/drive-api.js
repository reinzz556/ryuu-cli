import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { google } from 'googleapis';
import { RyuuError } from '../../src/utils/errors.js';
import { describeOAuthFailure } from './auth.js';

/**
 * Thin, guarded wrapper around Google Drive API v3.
 *
 * Every method returns plain data (no googleapis response envelope) and maps
 * failures onto RyuuError with an Indonesian message. Nothing here ever returns
 * an access token.
 */

const API = 'DRIVE_API';
const FILE_FIELDS = 'id,name,mimeType,size,createdTime,modifiedTime,webViewLink,parents,trashed,owners(displayName,emailAddress)';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

function apiError(error, action) {
  const status = error?.response?.status || error?.code;
  const data = error?.response?.data || {};
  const reason = data?.error?.errors?.[0]?.reason || data?.error || '';
  const base = { code: API, status, reason: String(reason || '') };
  if (status === 401) {
    return new RyuuError(`Akses Google Drive ditolak (401). Jalankan /drive login.`, base);
  }
  if (status === 403) {
    if (/quota/i.test(String(reason)) || /storageQuota/i.test(String(data?.error?.message || ''))) {
      return new RyuuError('Kuota Google Drive habis atau rate limit API tercapai. Coba lagi nanti.', base);
    }
    return new RyuuError(
      `Google Drive menolak akses (403): ${reason || 'permission denied'}. Pastikan scope drive.file mencakup file ini (file harus dibuat/dibuka oleh Ryuu).`,
      base,
    );
  }
  if (status === 404) return new RyuuError('File atau folder Google Drive tidak ditemukan, atau bukan milik akun ini.', base);
  if (status === 429) return new RyuuError('Rate limit Google Drive tercapai (429). Coba lagi beberapa saat.', base);
  if (status >= 500) return new RyuuError(`Google Drive sedang bermasalah (${status}). Coba lagi nanti.`, base);
  if (['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN'].includes(status)) {
    return new RyuuError('Tidak dapat menghubungi Google Drive (masalah jaringan).', base);
  }
  if (status === 'ENOSPC') return new RyuuError('Disk penuh: tidak ada ruang untuk menulis file.', base);
  return new RyuuError(`${action} gagal: ${error?.message || describeOAuthFailure(error)}`, base);
}

function escapeQueryText(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Build a Drive `q` expression from structured filters. */
export function buildSearchQuery({ query = null, name = null, mimeType = null, folderId = null, trashed = false } = {}) {
  const parts = [];
  if (query) parts.push(`(${String(query)})`);
  if (name) parts.push(`name contains '${escapeQueryText(name)}'`);
  if (mimeType) parts.push(`mimeType = '${escapeQueryText(mimeType)}'`);
  if (folderId) parts.push(`'${escapeQueryText(folderId)}' in parents`);
  parts.push(trashed ? 'trashed = true' : 'trashed = false');
  return parts.join(' and ');
}

function toFileSummary(file) {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    isFolder: file.mimeType === FOLDER_MIME,
    size: file.size ? Number(file.size) : null,
    createdTime: file.createdTime || null,
    modifiedTime: file.modifiedTime || null,
    webViewLink: file.webViewLink || null,
    parents: file.parents || [],
  };
}

export class DriveClient {
  constructor({ auth, logger = null }) {
    this.auth = auth;
    this.logger = logger;
    this.drive = google.drive({ version: 'v3', auth });
  }

  /** Account identity + storage quota, read from the Drive API itself. */
  async getAbout() {
    try {
      const { data } = await this.drive.about.get({ fields: 'user(displayName,emailAddress,permissionId),storageQuota' });
      return {
        email: data.user?.emailAddress || null,
        name: data.user?.displayName || null,
        permissionId: data.user?.permissionId || null,
        storageQuota: data.storageQuota
          ? {
              limit: data.storageQuota.limit ? Number(data.storageQuota.limit) : null,
              usage: data.storageQuota.usage ? Number(data.storageQuota.usage) : null,
              usageInDrive: data.storageQuota.usageInDrive ? Number(data.storageQuota.usageInDrive) : null,
              usageInDriveTrash: data.storageQuota.usageInDriveTrash
                ? Number(data.storageQuota.usageInDriveTrash)
                : null,
            }
          : null,
      };
    } catch (error) {
      throw apiError(error, 'Membaca informasi akun');
    }
  }

  /** Search files; supports Shared Drive items explicitly. */
  async search({ query = null, name = null, mimeType = null, folderId = null, pageSize = 25, pageToken = null, orderBy = 'modifiedTime desc', trashed = false } = {}) {
    const size = Math.min(Math.max(Number(pageSize) || 25, 1), 100);
    try {
      const { data } = await this.drive.files.list({
        q: buildSearchQuery({ query, name, mimeType, folderId, trashed }),
        pageSize: size,
        pageToken: pageToken || undefined,
        orderBy: orderBy || undefined,
        fields: `nextPageToken, files(${FILE_FIELDS})`,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      return { files: (data.files || []).map(toFileSummary), nextPageToken: data.nextPageToken || null };
    } catch (error) {
      throw apiError(error, 'Pencarian file');
    }
  }

  /** List a folder's direct children ('root' when folderId is omitted). */
  async list({ folderId = 'root', pageSize = 50, pageToken = null, orderBy = 'folder,name' } = {}) {
    const id = folderId || 'root';
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
    try {
      const { data } = await this.drive.files.list({
        q: `'${escapeQueryText(id)}' in parents and trashed = false`,
        pageSize: size,
        pageToken: pageToken || undefined,
        orderBy: orderBy || undefined,
        fields: `nextPageToken, files(${FILE_FIELDS})`,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      return { folderId: id, files: (data.files || []).map(toFileSummary), nextPageToken: data.nextPageToken || null };
    } catch (error) {
      throw apiError(error, 'Membaca isi folder');
    }
  }

  async getMetadata({ fileId }) {
    try {
      const { data } = await this.drive.files.get({
        fileId,
        fields: `${FILE_FIELDS},description,shared,capabilities(canDownload,canEdit,canDelete),shortcutDetails`,
        supportsAllDrives: true,
      });
      return { ...toFileSummary(data), description: data.description || null, shared: Boolean(data.shared), capabilities: data.capabilities || null };
    } catch (error) {
      throw apiError(error, 'Membaca metadata file');
    }
  }

  async createFolder({ name, parentId = 'root' }) {
    try {
      const { data } = await this.drive.files.create({
        requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId || 'root'] },
        fields: FILE_FIELDS,
        supportsAllDrives: true,
      });
      return toFileSummary(data);
    } catch (error) {
      throw apiError(error, 'Membuat folder');
    }
  }

  /** Find a child folder by exact name, creating it when missing. */
  async ensureFolder({ name, parentId = 'root' }) {
    const existing = await this.search({
      name,
      mimeType: FOLDER_MIME,
      folderId: parentId || 'root',
      pageSize: 10,
    });
    const hit = existing.files.find((file) => file.name === name && file.isFolder);
    if (hit) return hit;
    return this.createFolder({ name, parentId });
  }

  /** Streaming upload from a local file (no full buffer in memory). */
  async uploadFile({ filePath, fileName = null, folderId = 'root', mimeType = 'application/octet-stream', onProgress = null }) {
    let size;
    try {
      size = (await fsp.stat(filePath)).size;
    } catch (error) {
      throw new RyuuError(`File lokal tidak dapat dibaca: ${filePath} (${error.message})`, { code: 'DRIVE_LOCAL' });
    }
    try {
      const { data } = await this.drive.files.create(
        {
          requestBody: { name: fileName || path.basename(filePath), parents: [folderId || 'root'], mimeType },
          media: { mimeType, body: fs.createReadStream(filePath) },
          fields: FILE_FIELDS,
          supportsAllDrives: true,
        },
        onProgress ? { onUploadProgress: (event) => onProgress({ loaded: event.bytesRead, total: size }) } : undefined,
      );
      return { ...toFileSummary(data), uploadedBytes: size };
    } catch (error) {
      throw apiError(error, 'Upload file');
    }
  }

  /** Streaming download to a local path that the caller already validated. */
  async downloadFile({ fileId, destination, onProgress = null }) {
    try {
      const meta = await this.getMetadata({ fileId });
      if (meta.isFolder) {
        throw new RyuuError('Objek yang diminta adalah folder. Gunakan drive_restore untuk arsip backup.', { code: API });
      }
      const response = await this.drive.files.get(
        { fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream' },
      );
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      const writer = fs.createWriteStream(destination);
      let bytes = 0;
      await new Promise((resolve, reject) => {
        response.data.on('data', (chunk) => {
          bytes += chunk.length;
          if (onProgress) onProgress({ loaded: bytes, total: meta.size });
        });
        response.data.on('error', reject);
        writer.on('error', reject);
        writer.on('finish', resolve);
        response.data.pipe(writer);
      });
      return { ...meta, destination, bytes };
    } catch (error) {
      if (error instanceof RyuuError) throw error;
      throw apiError(error, 'Download file');
    }
  }

  async move({ fileId, toFolderId }) {
    try {
      const meta = await this.getMetadata({ fileId });
      const { data } = await this.drive.files.update({
        fileId,
        addParents: toFolderId,
        removeParents: (meta.parents || []).join(',') || undefined,
        fields: FILE_FIELDS,
        supportsAllDrives: true,
      });
      return toFileSummary(data);
    } catch (error) {
      throw apiError(error, 'Memindahkan file');
    }
  }

  async rename({ fileId, name }) {
    try {
      const { data } = await this.drive.files.update({
        fileId,
        requestBody: { name },
        fields: FILE_FIELDS,
        supportsAllDrives: true,
      });
      return toFileSummary(data);
    } catch (error) {
      throw apiError(error, 'Mengganti nama file');
    }
  }

  async copy({ fileId, name = null, folderId = null }) {
    try {
      const { data } = await this.drive.files.copy({
        fileId,
        requestBody: { ...(name ? { name } : {}), ...(folderId ? { parents: [folderId] } : {}) },
        fields: FILE_FIELDS,
        supportsAllDrives: true,
      });
      return toFileSummary(data);
    } catch (error) {
      throw apiError(error, 'Menyalin file');
    }
  }

  async remove({ fileId }) {
    try {
      await this.drive.files.delete({ fileId, supportsAllDrives: true });
      return { id: fileId, deleted: true };
    } catch (error) {
      throw apiError(error, 'Menghapus file');
    }
  }

  /** Confirm that a folder id exists and is a folder (Shared Drives included). */
  async assertFolder({ folderId, label = 'Folder tujuan' }) {
    if (!folderId || folderId === 'root') return { id: 'root', name: 'My Drive' };
    const meta = await this.getMetadata({ fileId: folderId });
    if (!meta.isFolder) {
      throw new RyuuError(`${label} ${folderId} bukan folder Google Drive.`, { code: API });
    }
    return meta;
  }
}

export { FOLDER_MIME, toFileSummary, apiError };
