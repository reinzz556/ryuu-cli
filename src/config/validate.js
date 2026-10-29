import fs from 'node:fs';
import path from 'node:path';
import { ConfigError } from '../utils/errors.js';
import {
  DEFAULT_PROVIDER_ID,
  MAX_MODEL_ID_LENGTH,
  MODEL_ID_PATTERN,
  buildProviders,
  isCatalogModel,
  parseExtraProviders,
  providerById,
  resolveProviderId,
} from '../providers/catalog.js';

/** Approval policies accepted by agent.approvalPolicy (also used by settings). */
export const APPROVAL_POLICIES = ['ask', 'auto', 'read-only'];
/** Log levels accepted by LOG_LEVEL (also used by settings). */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'];

/**
 * Numeric config limits: [min, max, default]. Exported so the settings editor
 * validates against exactly the same ranges as startup instead of copying them.
 */
export const CONFIG_LIMITS = {
  maxSteps: [0, 100000, 0],
  maxOutputTokens: [64, 32768, 4096],
  requestTimeoutMs: [1000, 600000, 120000],
  // Abort a response stream that stops producing bytes (0 disables). Without
  // this a dribbling endpoint can hold a step open for tens of minutes.
  streamIdleTimeoutMs: [0, 600000, 45000],
  maxRetries: [0, 10, 3],
  // 0 = keep reconnecting until the task ends (the heartbeat never gives up).
  maxRecoveryAttempts: [0, 1000, 0],
  recoveryBackoffMs: [100, 60000, 1000],
  maxFileBytes: [1024, 5 * 1024 * 1024, 262144],
  maxSearchResults: [1, 500, 50],
  maxToolOutputBytes: [1024, 1024 * 1024, 32768],
  maxTaskDurationMs: [10000, 24 * 60 * 60 * 1000, 15 * 60 * 1000],
  maxContextChars: [8000, 1000000, 120000],
  webSearchResults: [1, 10, 5],
  webSearchTimeoutMs: [1000, 60000, 15000],
  webMcpTimeoutMs: [1000, 30000, 6000],
  webMcpMaxRetries: [0, 5, 1],
};

const WEB_PROVIDER_IDS = ['serper', 'you', 'firecrawl', 'duckduckgo', 'tavily'];
const WEB_PROVIDER_DEFAULT = ['you', 'firecrawl', 'duckduckgo', 'tavily'];
const WEB_PLACEHOLDER_KEY = /^(your[_-]?.*api[_-]?key|changeme|replace[_-]?me|<.*>)$/i;

const DEFAULT_WEB_SEARCH_ENDPOINT = 'https://google.serper.dev/search';
const WEB_SEARCH_AUTH_HEADERS = ['X-API-KEY', 'Authorization'];
const SEARCH_PLACEHOLDER_KEY = /^(your[_-]?(search|serper|websearch)[_-]?api[_-]?key|changeme|replace[_-]?me|<.*>)$/i;

const PLACEHOLDER_KEY = /^(your[_-]?.*api[_-]?key|changeme|replace[_-]?me|<.*>)$/i;

function toInt(name, value, issues) {
  const [min, max, fallback] = CONFIG_LIMITS[name];
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    issues.push(`${name} must be an integer (received ${JSON.stringify(value)})`);
    return fallback;
  }
  if (parsed < min || parsed > max) {
    issues.push(`${name} must be between ${min} and ${max} (received ${parsed})`);
    return fallback;
  }
  return parsed;
}

function toBool(name, value, issues) {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  issues.push(`${name} must be a boolean (true/false), received ${JSON.stringify(value)}`);
  return false;
}

function toBoolDefault(name, value, issues, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return toBool(name, value, issues);
}

/** Parse a comma-separated provider list; unknown ids are a config error. */
function parseProviderList(name, value, issues) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim().toLowerCase();
  if (!text) return null;
  if (['none', 'off', 'disabled'].includes(text)) return [];
  const ids = [];
  for (const part of text.split(',')) {
    const id = part.trim();
    if (!id) continue;
    if (!WEB_PROVIDER_IDS.includes(id)) {
      issues.push(`${name} contains unknown provider ${JSON.stringify(id)} (allowed: ${WEB_PROVIDER_IDS.join(', ')})`);
      continue;
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Empty keys and obvious placeholders disable a provider instead of failing startup. */
function optionalKey(name, value, warnings) {
  let key = typeof value === 'string' ? value.trim() : '';
  if (key && WEB_PLACEHOLDER_KEY.test(key)) {
    warnings.push(`${name} looks like a placeholder; that provider stays disabled until a real key is set.`);
    key = '';
  }
  return key;
}

function resolveDir(value, base, label, issues) {
  if (!value) return null;
  try {
    return path.resolve(base, String(value));
  } catch {
    issues.push(`${label} is not a valid path: ${value}`);
    return null;
  }
}

/**
 * Normalize and validate a raw config.
 *
 * @param {object} raw
 * @param {object} options
 * @param {boolean} [options.requireApiKey=true] doctor/mock paths may pass false
 * @param {string} [options.cwd]
 * @returns {{config: object, warnings: string[]}}
 * @throws {ConfigError} when validation fails, listing every issue found
 */
export function validateConfig(raw = {}, { requireApiKey = true, cwd = raw.cwd || process.cwd() } = {}) {
  const issues = [];
  const warnings = [];

  // ---- providers -------------------------------------------------------
  // Built-in providers (nvidia, tokenharbor) plus any extraProviders entries,
  // each with its own base URL, key, model list and capabilities. Credentials
  // come from config.json only.
  const providerCredentials =
    raw.providerCredentials && typeof raw.providerCredentials === 'object' ? raw.providerCredentials : {};
  const extraProviders = parseExtraProviders(raw.extraProviders, issues);
  const providers = buildProviders({ credentials: providerCredentials, extras: extraProviders });

  const explicitProvider = raw.provider ? String(raw.provider).trim().toLowerCase() : null;
  const providerId = resolveProviderId({ explicit: explicitProvider, providers });
  let activeProvider = providerById(providers, providerId);
  if (!activeProvider) {
    issues.push(
      `provider ${JSON.stringify(raw.provider)} is not a known provider (known: ${providers
        .map((provider) => provider.id)
        .join(', ')}).`,
    );
    activeProvider = providerById(providers, DEFAULT_PROVIDER_ID) || providers[0];
  }

  // Generic overrides describe the active provider only (an explicit --model or
  // a caller building a config for tests). Per-provider values are already
  // baked into the descriptors above.
  const keyOverride = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
  if (keyOverride) activeProvider.apiKey = keyOverride;
  const baseUrlOverride = typeof raw.baseURL === 'string' ? raw.baseURL.trim() : '';
  if (baseUrlOverride) activeProvider.baseURL = baseUrlOverride;

  // Empty keys and obvious placeholders disable a provider instead of failing
  // startup; only the active provider's key is required.
  const placeholderProviders = new Set();
  for (const provider of providers) {
    if (!provider.apiKey) continue;
    if (PLACEHOLDER_KEY.test(provider.apiKey)) {
      placeholderProviders.add(provider.id);
      provider.apiKey = '';
      warnings.push(
        `${provider.apiKeyPath} looks like a placeholder; provider ${provider.id} stays unavailable until a real key is set.`,
      );
    }
  }

  const apiKey = activeProvider.apiKey;
  const apiKeyPath = activeProvider.apiKeyPath;
  if (!apiKey) {
    if (requireApiKey) {
      if (placeholderProviders.has(activeProvider.id)) {
        issues.push(
          `${apiKeyPath} still contains the example placeholder. Replace it with a real ${activeProvider.name} key${activeProvider.docsUrl ? ` from ${activeProvider.docsUrl}` : ''}.`,
        );
      } else {
        issues.push(
          `Provider ${activeProvider.id} has no API key. Add your ${activeProvider.name} key to config.json with \`ryuu --settings\` (${apiKeyPath}).`,
        );
      }
    }
  } else if (activeProvider.id === DEFAULT_PROVIDER_ID && !/^nvapi-[A-Za-z0-9._-]+$/.test(apiKey)) {
    warnings.push(
      `The ${apiKeyPath} value does not look like a typical NVIDIA key (nvapi-...). Continuing in case you use a proxy or gateway.`,
    );
  }

  const requestedModel = typeof raw.model === 'string' ? raw.model.trim() : '';
  const model = requestedModel || activeProvider.defaultModel;
  if (!model) {
    issues.push(`No model is selected for provider ${activeProvider.id}. Set ${activeProvider.modelPath}.`);
  } else if (!MODEL_ID_PATTERN.test(model) || model.length > MAX_MODEL_ID_LENGTH) {
    issues.push(`Model id contains unsupported characters: ${JSON.stringify(model)}`);
  } else if (!isCatalogModel(activeProvider, model)) {
    warnings.push(
      `Model ${JSON.stringify(model)} is not listed for provider ${activeProvider.id}. It is sent as-is and may fail; add it with /addmodel to keep it in the list.`,
    );
  }

  const baseUrlLabel = activeProvider.baseUrlPath;
  let baseURL = String(activeProvider.baseURL || '').trim();
  try {
    const parsed = new URL(baseURL);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      issues.push(`${baseUrlLabel} must use http or https, received ${parsed.protocol}`);
    } else if (parsed.protocol === 'http:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      warnings.push(`${baseUrlLabel} is plain http (${parsed.host}); the API key travels unencrypted.`);
    }
    baseURL = parsed.toString().replace(/\/$/, '');
  } catch {
    issues.push(`${baseUrlLabel} is not a valid URL: ${JSON.stringify(baseURL)}`);
  }

  let workspace = resolveDir(raw.workspace || '.', cwd, 'workspace', issues) || path.resolve(cwd);
  if (!fs.existsSync(workspace)) {
    issues.push(`Workspace does not exist: ${workspace}`);
  } else {
    try {
      if (!fs.statSync(workspace).isDirectory()) issues.push(`Workspace is not a directory: ${workspace}`);
      workspace = fs.realpathSync(workspace);
    } catch (error) {
      issues.push(`Cannot access workspace ${workspace}: ${error.message}`);
    }
  }

  const logLevel = String(raw.logLevel || 'info').toLowerCase();
  if (!LOG_LEVELS.includes(logLevel)) {
    issues.push(`agent.logLevel must be one of ${LOG_LEVELS.join(', ')} (received ${JSON.stringify(raw.logLevel)})`);
  }

  const approvalPolicy = String(raw.approvalPolicy || 'ask').toLowerCase();
  if (!APPROVAL_POLICIES.includes(approvalPolicy)) {
    issues.push(
      `agent.approvalPolicy must be one of ${APPROVAL_POLICIES.join(', ')} (received ${JSON.stringify(raw.approvalPolicy)})`,
    );
  }

  const values = {};
  for (const name of Object.keys(CONFIG_LIMITS)) {
    values[name] = toInt(name, raw[name], issues);
  }

  // Web search is opt-in: an empty key disables the tool instead of failing startup.
  let webSearchApiKey = typeof raw.webSearchApiKey === 'string' ? raw.webSearchApiKey.trim() : '';
  if (webSearchApiKey && SEARCH_PLACEHOLDER_KEY.test(webSearchApiKey)) {
    warnings.push('webSearch.serperApiKey looks like a placeholder; web_search is disabled until a real key is set.');
    webSearchApiKey = '';
  }

  let webSearchEndpoint = String(raw.webSearchEndpoint || DEFAULT_WEB_SEARCH_ENDPOINT).trim();
  try {
    const parsed = new URL(webSearchEndpoint);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      issues.push(`webSearch.endpoint must use http or https, received ${parsed.protocol}`);
    } else if (parsed.protocol === 'http:') {
      warnings.push(`webSearch.endpoint is plain http (${parsed.host}); the search query and API key travel unencrypted.`);
    }
    webSearchEndpoint = parsed.toString();
  } catch {
    issues.push(`webSearch.endpoint is not a valid URL: ${JSON.stringify(webSearchEndpoint)}`);
  }

  const webSearchAuthHeader = WEB_SEARCH_AUTH_HEADERS.find(
    (candidate) => candidate.toLowerCase() === String(raw.webSearchAuthHeader || 'X-API-KEY').toLowerCase(),
  );
  if (!webSearchAuthHeader) {
    issues.push(
      `webSearch.authHeader must be one of ${WEB_SEARCH_AUTH_HEADERS.join(', ')} (received ${JSON.stringify(raw.webSearchAuthHeader)})`,
    );
  }

  const webSearchEnabled = toBoolDefault('webSearch.enabled', raw.webSearchEnabled, issues, true);
  const webSearchFallback = toBoolDefault('webSearch.fallback', raw.webSearchFallback, issues, true);
  const webMcpDebug = toBoolDefault('webSearch.debug', raw.webMcpDebug, issues, false);
  const duckduckgoMcpEnabled = toBoolDefault('webSearch.duckduckgoEnabled', raw.duckduckgoMcpEnabled, issues, false);
  const youApiKey = optionalKey('webSearch.youApiKey', raw.youApiKey, warnings);
  const firecrawlApiKey = optionalKey('webSearch.firecrawlApiKey', raw.firecrawlApiKey, warnings);
  const tavilyApiKey = optionalKey('webSearch.tavilyApiKey', raw.tavilyApiKey, warnings);

  const explicitOrder = parseProviderList('webSearch.providers', raw.webSearchProviders, issues);
  const webSearchProviders = explicitOrder ?? [
    ...(webSearchApiKey ? ['serper'] : []),
    ...WEB_PROVIDER_DEFAULT,
  ];
  const webSearchDisabled = parseProviderList('webSearch.disabled', raw.webSearchDisabled, issues) || [];
  if (webSearchProviders.length === 0) {
    warnings.push('webSearch.providers is empty; web search is registered but no provider will be tried.');
  }
  const duckduckgoMcpCommand = String(raw.duckduckgoMcpCommand || 'uvx').trim();
  const duckduckgoMcpArgs = String(raw.duckduckgoMcpArgs || 'free-search-mcp')
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (duckduckgoMcpEnabled && webSearchProviders.includes('duckduckgo')) {
    warnings.push(
      'DuckDuckGo MCP is enabled: it starts the third-party command "' +
        `${duckduckgoMcpCommand} ${duckduckgoMcpArgs.join(' ')}" on first use with a minimal environment. Review that server before relying on it.`,
    );
  }

  if (values.maxOutputTokens > 8192) {
    warnings.push('agent.maxOutputTokens is high; the selected model may reject it or bill more aggressively.');
  }
  if (values.maxSteps > 50) {
    warnings.push('agent.maxSteps is high; long autonomous runs cost more tokens and time.');
  }

  const allowShell = toBool('agent.allowShell', raw.allowShell, issues);
  const debug = raw.debug === true || raw.debug === 'true' || raw.debug === '1';
  if (allowShell) {
    warnings.push('agent.allowShell=true enables shell syntax after explicit approval. Shell execution is NOT a sandbox.');
  }

  const stateRoot = path.join(workspace, '.ryuu');
  const historyDir = resolveDir(raw.historyDir, workspace, 'agent.historyDir', issues) || path.join(stateRoot, 'sessions');
  const logDir = resolveDir(raw.logDir, workspace, 'agent.logDir', issues) || path.join(stateRoot, 'logs');
  const undoDir = path.join(stateRoot, 'undo');
  const cacheDir = path.join(stateRoot, 'cache');

  const webSearch = {
    webSearchApiKey,
    webSearchEndpoint,
    webSearchAuthHeader: webSearchAuthHeader || 'X-API-KEY',
    webSearchResults: values.webSearchResults,
    webSearchTimeoutMs: values.webSearchTimeoutMs,
    webSearchEnabled,
    webSearchFallback,
    webSearchProviders,
    webSearchDisabled,
    webMcpTimeoutMs: values.webMcpTimeoutMs,
    webMcpMaxRetries: values.webMcpMaxRetries,
    webMcpDebug,
    youApiKey,
    firecrawlApiKey,
    tavilyApiKey,
    duckduckgoMcpEnabled,
    duckduckgoMcpCommand,
    duckduckgoMcpArgs,
  };

  if (issues.length > 0) {
    throw new ConfigError(
      `Configuration is invalid:\n- ${issues.join('\n- ')}`,
      { issues },
    );
  }

  return {
    config: {
      // Active provider selection (descriptors carry the per-provider keys so a
      // runtime /provider switch needs no extra environment lookup).
      providerId: activeProvider.id,
      providerName: activeProvider.name,
      provider: activeProvider.id,
      providers,
      apiKeyPath,
      capabilities: { ...activeProvider.capabilities },
      apiKey,
      model,
      baseURL,
      workspace,
      logLevel,
      approvalPolicy,
      allowShell,
      debug,
      ...values,
      ...webSearch,
      historyDir,
      logDir,
      undoDir,
      cacheDir,
    },
    warnings,
  };
}

/** Redacted config view for /config and /status. Never exposes the key. */
export function describeConfig(config) {
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const capabilityText = (capabilities = {}) =>
    [
      capabilities.streaming === false ? null : 'streaming',
      capabilities.tools === false ? null : 'tools',
      capabilities.reasoning ? 'reasoning' : null,
      capabilities.multimodal ? 'multimodal' : null,
    ]
      .filter(Boolean)
      .join('+') || 'text only';
  return {
    provider: `${config.providerName || 'NVIDIA Integrate API'} (${config.providerId || DEFAULT_PROVIDER_ID})`,
    baseURL: config.baseURL,
    model: config.model,
    apiKey: config.apiKey ? 'set (redacted)' : '(not set)',
    apiKeyPath: config.apiKeyPath || `providers.${DEFAULT_PROVIDER_ID}.apiKey`,
    capabilities: capabilityText(config.capabilities),
    providers: providers.length
      ? providers
          .map((provider) =>
            `${provider.id}${provider.id === (config.providerId || DEFAULT_PROVIDER_ID) ? '*' : ''}: ${
              provider.apiKey ? 'key set' : `no key (${provider.apiKeyPath})`
            }`,
          )
          .join(' · ')
      : 'unavailable',
    workspace: config.workspace,
    approvalPolicy: config.approvalPolicy,
    allowShell: config.allowShell,
    logLevel: config.logLevel,
    maxSteps: config.maxSteps,
    maxOutputTokens: config.maxOutputTokens,
    requestTimeoutMs: config.requestTimeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    maxRetries: config.maxRetries,
    maxRecoveryAttempts: config.maxRecoveryAttempts > 0 ? config.maxRecoveryAttempts : 'unlimited',
    recoveryBackoffMs: config.recoveryBackoffMs,
    maxFileBytes: config.maxFileBytes,
    maxSearchResults: config.maxSearchResults,
    maxToolOutputBytes: config.maxToolOutputBytes,
    maxTaskDurationMs: config.maxTaskDurationMs,
    maxContextChars: config.maxContextChars,
    webSearch: config.webSearchEnabled === false
      ? 'disabled (webSearch.enabled=false)'
      : `${config.webSearchProviders?.join(' → ') || 'no providers'} · fallback ${
          config.webSearchFallback === false ? 'off' : 'on'
        } · ${config.webMcpTimeoutMs}ms · ${config.webSearchResults} result(s)${
          config.webSearchApiKey ? ` · serper endpoint ${config.webSearchEndpoint}` : ''
        }`,
    webSearchKeys: {
      serper: Boolean(config.webSearchApiKey),
      you: Boolean(config.youApiKey),
      firecrawl: Boolean(config.firecrawlApiKey),
      tavily: Boolean(config.tavilyApiKey),
    },
    historyDir: config.historyDir,
    logDir: config.logDir,
  };
}
