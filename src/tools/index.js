import { ToolRegistry } from './registry.js';
import { createFilesystemTools } from './filesystem.js';
import { createSearchTools } from './search.js';
import { createGitTools } from './git.js';
import { createProjectTools } from './project.js';
import { createShellTools } from './shell.js';
import { createWebTools } from './web.js';
import { createUrlTools } from './url.js';
import { createWebSearchManager } from '../services/websearch/manager.js';

/**
 * Build the complete built-in tool registry. Collisions throw here.
 *
 * One WebSearchManager is shared by `web_search` and `read_url`, so provider
 * connections are reused and a page-extraction fallback can use a provider
 * discovered by an earlier search. The manager is exposed on the registry so
 * `/web` and `close()` can reach the same instance.
 */
export function buildToolRegistry({
  workspace,
  config,
  processes,
  logger = null,
  webManager = null,
  onEvent = null,
}) {
  const registry = new ToolRegistry({ logger });
  const manager = webManager || createWebSearchManager({ config, logger, onEvent });
  const groups = [
    createFilesystemTools({ workspace, config }),
    createSearchTools({ workspace, config, logger }),
    createGitTools({ workspace, logger }),
    createProjectTools({ workspace, logger }),
    createShellTools({ workspace, config, processes, logger }),
    // read_url needs no key, so it is always available: search snippets are
    // leads, and the model must be able to open the source page. When a local
    // fetch cannot read the page, an extraction-capable provider is tried.
    createUrlTools({ logger, webManager: manager }),
    // Empty when no provider is configured: the model never sees a tool that
    // cannot run, and the system prompt catalog stays accurate.
    createWebTools({ config, logger, manager }),
  ];
  for (const tools of groups) {
    for (const tool of tools) registry.register(tool);
  }
  registry.webSearchManager = manager;
  return registry;
}
