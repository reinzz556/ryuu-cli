import fsp from 'node:fs/promises';
import { defineTool } from '../../../../src/tools/registry.js';
import { fileLine, formatBytes, resolveLocal } from './tool-helpers.js';

/**
 * File discovery and file management tools (search, list, metadata, download,
 * upload, folder, move, rename, copy, delete).
 *
 * Destructive operations are declared destructive AND are re-checked against
 * `confirmDestructive` at execution time, so a model cannot opt itself out of
 * the safety check by sending an extra parameter.
 */
export function createFileTools(plugin) {
  return [
    defineTool({
      name: 'drive_search',
      description:
        'Search Google Drive files by name, MIME type, parent folder id, or a raw Drive query string. Returns id, name, MIME type, size and timestamps for each match.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Substring of the file name (case-insensitive on Drive side).' },
          mimeType: {
            type: 'string',
            description: 'Exact MIME type, e.g. application/pdf or application/vnd.google-apps.folder.',
          },
          folderId: { type: 'string', description: 'Only search direct children of this folder id.' },
          query: {
            type: 'string',
            description: "Raw Drive query fragment, e.g. \"fullText contains 'invoice'\".",
          },
          pageSize: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum results (default 25).' },
          pageToken: { type: 'string', description: 'Token from a previous call for the next page.' },
          orderBy: { type: 'string', description: 'Drive orderBy clause (default "modifiedTime desc").' },
        },
      },
      async handler(args) {
        const drive = await plugin.requireClient();
        const result = await drive.search({
          name: args.name || null,
          mimeType: args.mimeType || null,
          folderId: args.folderId || null,
          query: args.query || null,
          pageSize: args.pageSize ?? 25,
          pageToken: args.pageToken || null,
          orderBy: args.orderBy || 'modifiedTime desc',
        });
        return {
          ok: true,
          count: result.files.length,
          files: result.files.map((file) => ({ ...file, sizeLabel: formatBytes(file.size) })),
          nextPageToken: result.nextPageToken,
        };
      },
    }),

    defineTool({
      name: 'drive_list',
      description: 'List the immediate contents of a Google Drive folder (use "root" or omit the id for My Drive).',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          folderId: { type: 'string', description: 'Folder id to list; omit for My Drive root.' },
          pageSize: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum entries (default 50).' },
          pageToken: { type: 'string', description: 'Token from a previous call for the next page.' },
          orderBy: { type: 'string', description: 'Drive orderBy clause (default "folder,name").' },
        },
      },
      async handler(args) {
        const drive = await plugin.requireClient();
        const result = await drive.list({
          folderId: args.folderId || 'root',
          pageSize: args.pageSize ?? 50,
          pageToken: args.pageToken || null,
          orderBy: args.orderBy || 'folder,name',
        });
        return {
          ok: true,
          folderId: result.folderId,
          count: result.files.length,
          files: result.files.map((file) => ({ ...file, sizeLabel: formatBytes(file.size) })),
          nextPageToken: result.nextPageToken,
        };
      },
    }),

    defineTool({
      name: 'drive_get_metadata',
      description:
        'Get full metadata for one Drive file or folder: id, name, MIME type, size, created/modified time, parent folders and web view link.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: { fileId: { type: 'string', description: 'Google Drive file or folder id.' } },
        required: ['fileId'],
      },
      async handler(args) {
        const drive = await plugin.requireClient();
        const meta = await drive.getMetadata({ fileId: args.fileId });
        return { ok: true, ...meta, sizeLabel: formatBytes(meta.size) };
      },
    }),

    defineTool({
      name: 'drive_download',
      description:
        'Download a Drive file to a local path inside the workspace. The destination must be relative to the workspace root; an existing file is not overwritten unless overwrite=true.',
      risk: 'write',
      requiresApproval: true,
      schema: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: 'Google Drive file id to download.' },
          destinationPath: {
            type: 'string',
            description: 'Local destination file path relative to the workspace root, e.g. "downloads/report.pdf".',
          },
          overwrite: { type: 'boolean', description: 'Replace an existing local file. Default false.' },
        },
        required: ['fileId', 'destinationPath'],
      },
      async handler(args, ctx) {
        const drive = await plugin.requireClient();
        const target = resolveLocal(ctx, plugin, args.destinationPath);
        if (!args.overwrite) {
          const exists = await fsp.stat(target.realPath).then(() => true).catch(() => false);
          if (exists) {
            return {
              ok: false,
              error: {
                code: 'DESTINATION_EXISTS',
                message: `File lokal sudah ada: ${target.relPath}. Kirim overwrite=true bila memang ingin menggantinya.`,
              },
            };
          }
        }
        const result = await drive.downloadFile({ fileId: args.fileId, destination: target.realPath });
        return {
          ok: true,
          fileId: result.id,
          name: result.name,
          mimeType: result.mimeType,
          destinationPath: target.relPath,
          bytes: result.bytes,
          sizeLabel: formatBytes(result.bytes),
        };
      },
    }),

    defineTool({
      name: 'drive_upload',
      description:
        'Upload a local workspace file to Google Drive with streaming (the file is never buffered in memory). Large uploads are capped by maxUploadSize in the plugin config.',
      risk: 'write',
      requiresApproval: true,
      schema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Local file path relative to the workspace root.' },
          fileName: { type: 'string', description: 'Name to use on Drive. Defaults to the local file name.' },
          folderId: { type: 'string', description: 'Destination folder id. Omit for My Drive root.' },
          mimeType: {
            type: 'string',
            description: 'Content type to store, e.g. application/zip, application/pdf, text/plain.',
          },
        },
        required: ['filePath'],
      },
      async handler(args, ctx) {
        const drive = await plugin.requireClient();
        const settings = await plugin.loadConfig();
        const source = resolveLocal(ctx, plugin, args.filePath, { mustExist: true });
        const stat = await fsp.stat(source.realPath);
        if (!stat.isFile()) {
          return { ok: false, error: { code: 'NOT_A_FILE', message: `Bukan file biasa: ${source.relPath}` } };
        }
        if (settings.maxUploadSize && stat.size > settings.maxUploadSize) {
          return {
            ok: false,
            error: {
              code: 'UPLOAD_TOO_LARGE',
              message: `Ukuran ${formatBytes(stat.size)} melebihi maxUploadSize ${formatBytes(settings.maxUploadSize)}. Naikkan lewat /drive config set maxUploadSize <byte>.`,
            },
          };
        }
        const uploaded = await drive.uploadFile({
          filePath: source.realPath,
          fileName: args.fileName || null,
          folderId: args.folderId || 'root',
          mimeType: args.mimeType || 'application/octet-stream',
        });
        return {
          ok: true,
          file: { ...uploaded, sizeLabel: formatBytes(uploaded.size) },
          localPath: source.relPath,
        };
      },
    }),

    defineTool({
      name: 'drive_create_folder',
      description: 'Create a new Google Drive folder inside a parent folder.',
      risk: 'write',
      requiresApproval: true,
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Folder name.' },
          parentId: { type: 'string', description: 'Parent folder id. Omit for My Drive root.' },
        },
        required: ['name'],
      },
      async handler(args) {
        const drive = await plugin.requireClient();
        const folder = await drive.createFolder({ name: args.name, parentId: args.parentId || 'root' });
        return { ok: true, folder };
      },
    }),

    defineTool({
      name: 'drive_move',
      description: 'Move a Drive file or folder into another folder (the previous parents are removed).',
      risk: 'write',
      requiresApproval: true,
      schema: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: 'Item id to move.' },
          toFolderId: { type: 'string', description: 'Destination folder id.' },
        },
        required: ['fileId', 'toFolderId'],
      },
      async handler(args) {
        const drive = await plugin.requireClient();
        await drive.assertFolder({ folderId: args.toFolderId });
        return { ok: true, file: await drive.move({ fileId: args.fileId, toFolderId: args.toFolderId }) };
      },
    }),

    defineTool({
      name: 'drive_rename',
      description: 'Rename a Google Drive file or folder without moving it.',
      risk: 'write',
      requiresApproval: true,
      schema: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: 'Item id to rename.' },
          name: { type: 'string', description: 'New name.' },
        },
        required: ['fileId', 'name'],
      },
      async handler(args) {
        const drive = await plugin.requireClient();
        return { ok: true, file: await drive.rename({ fileId: args.fileId, name: args.name }) };
      },
    }),

    defineTool({
      name: 'drive_copy',
      description: 'Copy a Google Drive file, optionally into another folder and under a new name.',
      risk: 'write',
      requiresApproval: true,
      schema: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: 'File id to copy (folders cannot be copied).' },
          name: { type: 'string', description: 'Name for the copy. Defaults to Drive behaviour ("Copy of …").' },
          folderId: { type: 'string', description: 'Destination folder id for the copy.' },
        },
        required: ['fileId'],
      },
      async handler(args) {
        const drive = await plugin.requireClient();
        return {
          ok: true,
          file: await drive.copy({ fileId: args.fileId, name: args.name || null, folderId: args.folderId || null }),
        };
      },
    }),

    defineTool({
      name: 'drive_delete',
      description:
        'Permanently delete a Drive file or folder. This cannot be undone from Ryuu. Only call it after the user explicitly confirmed which file to delete.',
      risk: 'destructive',
      requiresApproval: true,
      assess: (args) => (String(args?.fileId || '') ? 'critical' : 'normal'),
      schema: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: 'Drive file or folder id to delete.' },
        },
        required: ['fileId'],
      },
      preview: async (args) => {
        try {
          const drive = await plugin.getClient();
          const meta = await drive.getMetadata({ fileId: args.fileId });
          return `Hapus permanen: ${meta.name} (${meta.isFolder ? 'folder' : formatBytes(meta.size)})\nid: ${meta.id}\n${fileLine(meta)}`;
        } catch (error) {
          return `Hapus permanen id ${args.fileId} (metadata tidak terbaca: ${error.message})`;
        }
      },
      async handler(args) {
        const drive = await plugin.requireClient();
        const meta = await drive.getMetadata({ fileId: args.fileId });
        await drive.remove({ fileId: args.fileId });
        return { ok: true, deleted: true, file: { id: meta.id, name: meta.name, isFolder: meta.isFolder } };
      },
    }),
  ];
}
