/**
 * Web search — the only tool that reaches outside the workspace.
 *
 * The request is routed through WebSearchManager, which tries the configured
 * providers in order (MCP servers plus the Serper-compatible REST backend) and
 * normalizes every result to `title / url / snippet`. The model sees one tool
 * and one result shape regardless of which provider answered.
 *
 * Results are leads, not proof: the description tells the model to cite the URL
 * it used, and `read_url` opens the page when a snippet is not enough.
 */

import { defineTool } from './registry.js';
import { createWebSearchManager } from '../services/websearch/manager.js';

const MAX_QUERY_CHARS = 400;

/**
 * Build the web search tool.
 *
 * @param {object} options
 * @param {object} options.config validated config
 * @param {object} [options.logger]
 * @param {Function} [options.fetch] injectable fetch for the Serper backend (tests)
 * @param {object} [options.manager] injected WebSearchManager
 * @returns {object[]} zero tools when no provider is available
 */
export function createWebTools({ config, logger = null, fetch = null, manager = null }) {
  const webManager = manager || createWebSearchManager({ config, logger, fetch });
  if (typeof webManager.hasProviders === 'function' && !webManager.hasProviders()) return [];

  return [
    defineTool({
      name: 'web_search',
      description:
        'Search the public web for current information the workspace cannot hold: library/API versions, release notes, unfamiliar error messages. ' +
        'Use only after local evidence cannot answer, because the query leaves this machine. ' +
        'Several providers are tried automatically when one fails; the result names the provider that answered. ' +
        'Results are snippets: leads, not proof — cite the URL you used and mark unverified claims. Use read_url to open a source. ' +
        'Do not repeat a query that already returned results.',
      risk: 'read',
      requiresApproval: false,
      schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_QUERY_CHARS,
            description: 'Search query. Include the library/product name and version when relevant.',
          },
          depth: {
            type: 'string',
            enum: ['standard', 'deep'],
            description: 'standard: a few best results (default). deep: twice as many results plus related questions.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      handler: async (args, ctx = {}) => webManager.search(
        { query: args.query, depth: args.depth },
        { signal: ctx.signal || null },
      ),
    }),
  ];
}
