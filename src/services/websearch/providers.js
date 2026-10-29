/**
 * Provider presets for web search.
 *
 * Endpoints and tool names were checked against the live servers (You.com and
 * Firecrawl answered MCP discovery on 2026-10-23). Capabilities are *declared*
 * here only as hints; the manager maps the tools that discovery actually
 * returns, so a provider that changes its tool set keeps working.
 *
 * API keys are optional where the service allows keyless use. They are read
 * from config.json and placed in request headers, never in a URL or log.
 */

import { createSerperProvider } from './serper.js';

export const PROVIDER_IDS = ['serper', 'you', 'firecrawl', 'duckduckgo', 'tavily'];

export const DEFAULT_PROVIDER_ORDER = ['serper', 'you', 'firecrawl', 'duckduckgo', 'tavily'];

export const PROVIDER_INFO = {
  serper: {
    label: 'Serper',
    transport: 'https',
    requiresKey: true,
    keySetting: 'webSearch.serperApiKey',
    docs: 'https://serper.dev',
    note: 'Serper-compatible SERP REST API (pre-existing backend).',
  },
  you: {
    label: 'You.com',
    transport: 'streamable-http',
    requiresKey: false,
    keySetting: 'webSearch.youApiKey',
    docs: 'https://you.com/docs/agents/mcp-server',
    note: 'Free profile is keyless and search-only; a key adds contents/discovery tools.',
  },
  firecrawl: {
    label: 'Firecrawl',
    transport: 'streamable-http',
    requiresKey: false,
    keySetting: 'webSearch.firecrawlApiKey',
    docs: 'https://docs.firecrawl.dev/mcp-server/keyless',
    note: 'Keyless search + scrape with a daily credit cap; a key raises limits.',
  },
  duckduckgo: {
    label: 'DuckDuckGo',
    transport: 'stdio',
    requiresKey: false,
    keySetting: null,
    docs: 'https://github.com/sweetcornna/free-search-mcp',
    note: 'Local community server (MIT). Disabled by default: it runs third-party code and needs uv/uvx.',
  },
  tavily: {
    label: 'Tavily',
    transport: 'streamable-http',
    requiresKey: true,
    keySetting: 'webSearch.tavilyApiKey',
    docs: 'https://docs.tavily.com/documentation/mcp',
    note: 'Agent-oriented search and extraction; API key required by the remote MCP endpoint.',
  },
};

const trim = (value) => String(value ?? '').trim();

/** Build the provider descriptors in the configured order. */
export function buildProviders(config = {}, { fetch = null } = {}) {
  const order = Array.isArray(config.webSearchProviders) && config.webSearchProviders.length > 0
    ? config.webSearchProviders
    : DEFAULT_PROVIDER_ORDER;
  const disabled = new Set(Array.isArray(config.webSearchDisabled) ? config.webSearchDisabled : []);
  const providers = [];

  for (const id of order) {
    if (!PROVIDER_IDS.includes(id)) continue;
    if (id === 'serper') {
      const provider = createSerperProvider({ config, fetch });
      provider.enabled = !disabled.has('serper');
      providers.push(provider);
      continue;
    }

    if (id === 'you') {
      const apiKey = trim(config.youApiKey);
      providers.push({
        id: 'you',
        label: 'You.com',
        kind: 'mcp',
        transport: 'streamable-http',
        url: apiKey ? 'https://api.you.com/mcp' : 'https://api.you.com/mcp?profile=free',
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        requiresKey: false,
        configured: true,
        enabled: !disabled.has('you'),
        authenticated: Boolean(apiKey),
        // With a key the default tool allowlist includes you-contents; without
        // one the free profile is search-only (confirmed by discovery).
        capabilities: { search: true, extract: Boolean(apiKey) },
        keySetting: 'webSearch.youApiKey',
      });
      continue;
    }

    if (id === 'firecrawl') {
      const apiKey = trim(config.firecrawlApiKey);
      providers.push({
        id: 'firecrawl',
        label: 'Firecrawl',
        kind: 'mcp',
        transport: 'streamable-http',
        url: 'https://mcp.firecrawl.dev/v2/mcp',
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        requiresKey: false,
        configured: true,
        enabled: !disabled.has('firecrawl'),
        authenticated: Boolean(apiKey),
        capabilities: { search: true, extract: true },
        keySetting: 'webSearch.firecrawlApiKey',
      });
      continue;
    }

    if (id === 'duckduckgo') {
      const command = trim(config.duckduckgoMcpCommand) || 'uvx';
      const args = Array.isArray(config.duckduckgoMcpArgs) && config.duckduckgoMcpArgs.length > 0
        ? config.duckduckgoMcpArgs
        : ['free-search-mcp'];
      providers.push({
        id: 'duckduckgo',
        label: 'DuckDuckGo',
        kind: 'mcp',
        transport: 'stdio',
        command,
        args,
        env: {},
        requiresKey: false,
        configured: Boolean(command),
        enabled: Boolean(config.duckduckgoMcpEnabled) && !disabled.has('duckduckgo'),
        capabilities: { search: true, extract: true },
        keySetting: null,
      });
      continue;
    }

    if (id === 'tavily') {
      const apiKey = trim(config.tavilyApiKey);
      providers.push({
        id: 'tavily',
        label: 'Tavily',
        kind: 'mcp',
        transport: 'streamable-http',
        url: 'https://mcp.tavily.com/mcp/',
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        requiresKey: true,
        configured: Boolean(apiKey),
        enabled: !disabled.has('tavily'),
        authenticated: Boolean(apiKey),
        capabilities: { search: true, extract: true },
        keySetting: 'webSearch.tavilyApiKey',
      });
    }
  }

  return providers;
}

/** Public, secret-free view of a provider for `/web` and logs. */
export function describeProvider(provider) {
  return {
    id: provider.id,
    label: provider.label,
    transport: provider.transport,
    enabled: provider.enabled,
    configured: provider.configured,
    requiresKey: provider.requiresKey,
    authenticated: Boolean(provider.authenticated),
    capabilities: { ...provider.capabilities },
    keySetting: provider.keySetting || null,
  };
}
