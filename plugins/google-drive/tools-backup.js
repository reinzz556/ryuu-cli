import { defineTool } from '../../src/tools/registry.js';
import { formatBytes, resolveLocal } from './tool-helpers.js';
import { backupToDrive, deleteBackup, listBackups, restoreFromDrive } from './backup.js';

/**
 * Backup, restore and Drive-information tools.
 *
 * `drive_delete_backup` and a restore that overwrites local files are declared
 * as `destructive`, so the CLI approval manager asks the user before they run.
 */
export function createBackupTools(plugin) {
  const destructiveRestore = (args) => (args?.overwrite ? 'critical' : 'normal');

  return [
    defineTool({
      name: 'drive_backup',
      description:
        'Backup a local project directory into a ZIP archive on Google Drive. Use this instead of making an archive yourself: it walks the directory, applies exclusion patterns, streams the ZIP, uploads it and returns the file id and Drive link.',
      risk: 'write',
      requiresApproval: true,
      schema: {
        type: 'object',
        properties: {
          sourcePath: {
            type: 'string',
            description: 'Directory to back up, relative to the workspace root. Default ".".',
          },
          destinationFolderId: {
            type: 'string',
            description: 'Google Drive folder id for the archive. Omit to use the default backup folder, or "root".',
          },
          archiveName: {
            type: 'string',
            description: 'Archive file name; must end in .zip. Omit for <name>-backup-YYYYMMDD-HHmmss.zip.',
          },
          excludePatterns: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Extra glob patterns to exclude (e.g. ["dist", "*.sqlite"]). node_modules, .git, .env, keys and caches are always excluded.',
          },
          includePatterns: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional allow-list of glob patterns; when set, only matching files are archived.',
          },
          compressionLevel: {
            type: 'integer',
            minimum: 0,
            maximum: 9,
            description: 'Deflate level 0-9 (0 stores files without compression). Default 6.',
          },
        },
        required: ['sourcePath'],
      },
      async handler(args, ctx) {
        const drive = await plugin.requireClient();
        const settings = await plugin.loadConfig();
        const source = resolveLocal(ctx, plugin, args.sourcePath || '.', { mustExist: true });
        const result = await backupToDrive({
          drive,
          sourceRoot: source.realPath,
          destinationFolderId: args.destinationFolderId || settings.defaultBackupFolder || 'root',
          archiveName: args.archiveName || null,
          excludePatterns: [...(args.excludePatterns || [])],
          includePatterns: args.includePatterns || [],
          compressionLevel: args.compressionLevel ?? 6,
          maxUploadSize: settings.maxUploadSize,
          signal: ctx?.signal || null,
          logger: plugin.logger,
        });
        return {
          ok: true,
          ...result,
          sizeLabel: formatBytes(result.size),
          excludedPatterns: result.excludedPatterns,
        };
      },
    }),

    defineTool({
      name: 'drive_restore',
      description:
        'Download a backup ZIP from Google Drive and extract it into a local directory. Use drive_list_backups first to pick the right archive. Existing files are never replaced unless overwrite=true is passed explicitly.',
      risk: 'write',
      requiresApproval: true,
      assess: destructiveRestore,
      schema: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: 'Google Drive file id of the backup archive.' },
          destinationPath: {
            type: 'string',
            description: 'Destination directory relative to the workspace root (created when missing). Default "restore".',
          },
          overwrite: {
            type: 'boolean',
            description: 'Replace files that already exist. Default false, which stops the restore instead of overwriting.',
          },
        },
        required: ['fileId'],
      },
      async handler(args, ctx) {
        const drive = await plugin.requireClient();
        const target = resolveLocal(ctx, plugin, args.destinationPath || 'restore');
        const result = await restoreFromDrive({
          drive,
          fileId: args.fileId,
          destinationRoot: target.realPath,
          overwrite: Boolean(args.overwrite),
          signal: ctx?.signal || null,
          logger: plugin.logger,
        });
        return { ok: true, ...result, bytesLabel: formatBytes(result.bytes) };
      },
    }),

    defineTool({
      name: 'drive_list_backups',
      description: 'List ZIP backup archives stored in a Google Drive folder, newest first.',
      risk: 'read',
      schema: {
        type: 'object',
        properties: {
          folderId: { type: 'string', description: 'Folder id to list. Omit for the default backup folder, or "root".' },
          pageSize: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum archives to return (default 25).' },
          pageToken: { type: 'string', description: 'Opaque token from a previous call, for the next page.' },
        },
      },
      async handler(args) {
        const drive = await plugin.requireClient();
        const settings = await plugin.loadConfig();
        const result = await listBackups({
          drive,
          folderId: args.folderId || settings.defaultBackupFolder || 'root',
          pageSize: args.pageSize ?? 25,
          pageToken: args.pageToken || null,
        });
        return {
          ok: true,
          folderId: result.folderId ?? args.folderId ?? settings.defaultBackupFolder ?? 'root',
          backups: result.backups.map((file) => ({ ...file, sizeLabel: formatBytes(file.size) })),
          count: result.backups.length,
          nextPageToken: result.nextPageToken,
        };
      },
    }),

    defineTool({
      name: 'drive_delete_backup',
      description:
        'Permanently delete one backup archive (.zip) from Google Drive. This is destructive and only accepts archive files: ask the user for explicit confirmation before calling it.',
      risk: 'destructive',
      requiresApproval: true,
      assess: () => 'critical',
      schema: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: 'Google Drive file id of the backup archive to delete.' },
        },
        required: ['fileId'],
      },
      async handler(args) {
        const drive = await plugin.requireClient();
        return { ok: true, ...(await deleteBackup({ drive, fileId: args.fileId })) };
      },
    }),

    defineTool({
      name: 'drive_storage_info',
      description: 'Read the connected Google account storage quota from the Drive API (limit, usage and Drive usage).',
      risk: 'read',
      schema: { type: 'object', properties: {} },
      async handler() {
        const client = await plugin.requireClient();
        const about = await client.getAbout();
        const quota = about.storageQuota || {};
        return {
          ok: true,
          email: about.email,
          limit: quota.limit ?? null,
          usage: quota.usage ?? null,
          usageInDrive: quota.usageInDrive ?? null,
          usageInDriveTrash: quota.usageInDriveTrash ?? null,
          limitLabel: formatBytes(quota.limit),
          usageLabel: formatBytes(quota.usage),
          freeLabel: quota.limit && quota.usage !== null ? formatBytes(Math.max(quota.limit - quota.usage, 0)) : 'tidak tersedia',
        };
      },
    }),

    defineTool({
      name: 'drive_get_account',
      description: 'Return the Google account currently connected to Google Drive (name, email, permission id).',
      risk: 'read',
      schema: { type: 'object', properties: {} },
      async handler() {
        const client = await plugin.requireClient();
        const about = await client.getAbout();
        return { ok: true, ...about };
      },
    }),
  ];
}
