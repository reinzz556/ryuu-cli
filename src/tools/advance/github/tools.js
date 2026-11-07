import { createAccountTools } from './tools-account.js';
import { createRepoTools } from './tools-repos.js';
import { createIssueTools } from './tools-issues.js';
import { createPullTools } from './tools-pulls.js';
import { createReleaseTools } from './tools-releases.js';
import { createActionTools } from './tools-actions.js';

/**
 * Seluruh tool AI plugin GitHub.
 *
 * Hanya tool yang benar-benar diimplementasikan yang didaftarkan. Setiap tool
 * memakai kontrak registry Ryuu (name, description, schema, risk, handler),
 * sehingga approval, validasi schema, dan rendering berjalan tanpa jalur
 * khusus.
 */
export function createGitHubTools(plugin) {
  return [
    ...createAccountTools(plugin),
    ...createRepoTools(plugin),
    ...createIssueTools(plugin),
    ...createPullTools(plugin),
    ...createReleaseTools(plugin),
    ...createActionTools(plugin),
  ];
}
