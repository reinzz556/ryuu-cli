import path from 'node:path';
import { RyuuError, PathEscapeError } from '../../../../src/utils/errors.js';

/** Shared helpers for the Google Drive tool definitions. */

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(Number(bytes))) return 'tidak diketahui';
  const value = Number(bytes);
  if (value < KB) return `${value} B`;
  if (value < MB) return `${(value / KB).toFixed(1)} KB`;
  if (value < GB) return `${(value / MB).toFixed(1)} MB`;
  return `${(value / GB).toFixed(2)} GB`;
}

/** Resolve a model-supplied local path inside the workspace, or refuse it. */
export function resolveLocal(ctx, plugin, inputPath, { mustExist = false } = {}) {
  const workspace = ctx?.workspace || plugin.workspace;
  if (!workspace) {
    throw new RyuuError('Workspace tidak tersedia untuk memvalidasi path lokal.', { code: 'DRIVE_PATH' });
  }
  const requested = String(inputPath ?? '').trim();
  if (!requested) throw new RyuuError('Path lokal wajib diisi.', { code: 'DRIVE_PATH' });
  if (path.isAbsolute(requested)) {
    throw new PathEscapeError(
      `Path lokal harus relatif terhadap workspace, bukan absolut: ${requested}`,
      { workspace: workspace.root, requested },
    );
  }
  const resolved = workspace.resolve(requested, { mustExist });
  workspace.assertNotSecret?.(resolved.relPath);
  return resolved;
}

/** Settings needed by the tools, loaded once per call. */
export async function loadSettings(plugin) {
  return plugin.loadConfig();
}

export function fileLine(file) {
  const kind = file.isFolder ? 'folder' : formatBytes(file.size);
  return `  ${file.name}  ·  ${kind}  ·  id: ${file.id}  ·  ${file.modifiedTime || '-'}`;
}
