import { createFileTools } from './tools-files.js';
import { createBackupTools } from './tools-backup.js';

/**
 * The complete AI tool set of the google-drive plugin.
 *
 * Every definition uses the registry's own `defineTool` contract (name,
 * description, JSON schema, risk, handler), so the providers that already
 * support Ryuu tool calling get these tools with no extra wiring.
 */
export function createDriveTools(plugin) {
  return [...createFileTools(plugin), ...createBackupTools(plugin)];
}
