import { createGoogleDrivePlugin } from './manager.js';

export { GoogleDrivePlugin, createGoogleDrivePlugin } from './manager.js';
export { DEFAULT_GOOGLE_DRIVE_CONFIG, EDITABLE_KEYS, drivePaths, readDriveConfig, validateConfigEntry } from './config.js';
export { describeCredentials } from './credentials.js';

/**
 * Plugin descriptor consumed by the host application.
 *
 * The host only needs three things: an id/name, a factory, and `tools`. Tools
 * are registered with `registry.registerPlugin(plugin)` when the integration is
 * enabled AND authenticated, and they are never handed to the model otherwise.
 */
export const googleDrivePluginDescriptor = Object.freeze({
  name: 'google-drive',
  version: '1.0.0',
  description: 'Google Drive integration: search, upload/download, folder management, backup and restore.',
  command: 'drive',
  dependencies: ['googleapis'],
});

export function createPlugin(options = {}) {
  return createGoogleDrivePlugin(options);
}

export default googleDrivePluginDescriptor;
