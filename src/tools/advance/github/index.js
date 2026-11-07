import { createGitHubPlugin } from './manager.js';

export { GitHubPlugin, createGitHubPlugin } from './manager.js';
export {
  DEFAULT_GITHUB_CONFIG,
  EDITABLE_KEYS,
  GITHUB_BACKEND_URL,
  GITHUB_CLIENT_ID,
  describeGitHubConfig,
  githubPaths,
  readGitHubConfig,
  readGitHubState,
  updateGitHubConfig,
  validateConfigEntry,
  writeGitHubConfig,
} from './config.js';
export { clearCredentials, describeCredentials, loadCredentials, saveCredentials } from './credentials.js';
export { GitHubBackendClient } from './backend.js';
export { GitHubApi } from './api.js';
export { createGitHubTools } from './tools.js';

/**
 * Deskriptor plugin untuk host aplikasi.
 *
 * Host hanya membutuhkan id/nama, factory, dan `tools`. Tool baru diberikan ke
 * model setelah plugin enabled DAN authenticated.
 */
export const githubPluginDescriptor = Object.freeze({
  name: 'github',
  version: '1.0.0',
  description:
    'Integrasi GitHub: login akun, repo, issue, pull request, release, dan GitHub Actions lewat backend Ryuu.',
  command: 'github',
  dependencies: [],
});

export function createPlugin(options = {}) {
  return createGitHubPlugin(options);
}

export default githubPluginDescriptor;
