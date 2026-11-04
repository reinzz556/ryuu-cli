import { createVercelPlugin } from './manager.js';

export { VercelPlugin, createVercelPlugin } from './manager.js';
export {
  CONFIG_REPAIR_HINT,
  DEFAULT_VERCEL_CONFIG,
  EDITABLE_KEYS,
  VERCEL_BACKEND_URL,
  VERCEL_CLIENT_ID,
  configurationPageUrl,
  describeVercelConfig,
  ensureVercelConfig,
  exampleVercelConfig,
  readVercelConfig,
  readVercelState,
  updateVercelConfig,
  validateConfigEntry,
  vercelPaths,
  writeVercelConfig,
  writeVercelState,
} from './config.js';
export { clearCredentials, describeCredentials, loadCredentials, saveCredentials } from './credentials.js';
export { VercelBackendClient } from './backend.js';
export { VercelApi } from './api.js';
export { createVercelTools } from './tools.js';
export { VercelPluginError, VERCEL_CODES } from './errors.js';

/**
 * Deskriptor plugin untuk host aplikasi.
 *
 * Host hanya membutuhkan id/nama, factory, dan `tools` (dari instance).
 * Tool diberikan ke model setelah plugin enabled DAN authenticated.
 */
export const vercelPluginDescriptor = Object.freeze({
  name: 'vercel',
  version: '1.0.0',
  description:
    'Integrasi Vercel: akun, team, project, deployment, environment variable, domain, DNS, Edge Config, dan monitoring lewat backend Ryuu.',
  command: 'vercel',
  dependencies: [],
});

export function createPlugin(options = {}) {
  return createVercelPlugin(options);
}

export default vercelPluginDescriptor;
