import fs from 'node:fs';
import path from 'node:path';
import { ConfigError } from '../utils/errors.js';
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from './load.js';

const APPROVAL_POLICIES = ['ask', 'auto', 'read-only'];
const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'];

const LIMITS = {
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

const PLACEHOLDER_KEY = /^(your[_-]?nvidia[_-]?api[_-]?key|changeme|replace[_-]?me|<.*>)$/i;

function toInt(name, value, issues) {
  const [min, max, fallback] = LIMITS[name];
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

  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
  if (!apiKey) {
    if (requireApiKey) {
      issues.push(
        'NVIDIA_API_KEY is not set. Copy .env.example to .env and add your NVIDIA key, or export NVIDIA_API_KEY in your shell.',
      );
    }
  } else if (PLACEHOLDER_KEY.test(apiKey)) {
    if (requireApiKey) {
      issues.push('NVIDIA_API_KEY still contains the example placeholder. Replace it with a real key from https://build.nvidia.com/.');
    } else {
      warnings.push('NVIDIA_API_KEY looks like a placeholder; live API calls will fail.');
    }
  } else if (!/^nvapi-[A-Za-z0-9._-]+$/.test(apiKey)) {
    warnings.push('NVIDIA_API_KEY does not look like a typical NVIDIA key (nvapi-...). Continuing in case you use a proxy or gateway.');
  }

  const model = String(raw.model || DEFAULT_MODEL).trim();
  if (!model) issues.push('NVIDIA_MODEL must not be empty');
  else if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)) {
    issues.push(`NVIDIA_MODEL contains unsupported characters: ${JSON.stringify(model)}`);
  }

  let baseURL = String(raw.baseURL || DEFAULT_BASE_URL).trim();
  try {
    const parsed = new URL(baseURL);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      issues.push(`NVIDIA_BASE_URL must use http or https, received ${parsed.protocol}`);
    }
    baseURL = parsed.toString().replace(/\/$/, '');
  } catch {
    issues.push(`NVIDIA_BASE_URL is not a valid URL: ${JSON.stringify(baseURL)}`);
  }

  let workspace = resolveDir(raw.workspace || '.', cwd, 'AGENT_WORKSPACE', issues) || path.resolve(cwd);
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
    issues.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')} (received ${JSON.stringify(raw.logLevel)})`);
  }

  const approvalPolicy = String(raw.approvalPolicy || 'ask').toLowerCase();
  if (!APPROVAL_POLICIES.includes(approvalPolicy)) {
    issues.push(`AGENT_APPROVAL_POLICY must be one of ${APPROVAL_POLICIES.join(', ')} (received ${JSON.stringify(raw.approvalPolicy)})`);
  }

  const values = {};
  for (const name of Object.keys(LIMITS)) {
    values[name] = toInt(name, raw[name], issues);
  }

  // Web search is opt-in: an empty key disables the tool instead of failing startup.
  let webSearchApiKey = typeof raw.webSearchApiKey === 'string' ? raw.webSearchApiKey.trim() : '';
  if (webSearchApiKey && SEARCH_PLACEHOLDER_KEY.test(webSearchApiKey)) {
    warnings.push('SEARCH_API_KEY looks like a placeholder; web_search is disabled until a real key is set.');
    webSearchApiKey = '';
  }

  let webSearchEndpoint = String(raw.webSearchEndpoint || DEFAULT_WEB_SEARCH_ENDPOINT).trim();
  try {
    const parsed = new URL(webSearchEndpoint);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      issues.push(`WEB_SEARCH_ENDPOINT must use http or https, received ${parsed.protocol}`);
    } else if (parsed.protocol === 'http:') {
      warnings.push(`WEB_SEARCH_ENDPOINT is plain http (${parsed.host}); the search query and API key travel unencrypted.`);
    }
    webSearchEndpoint = parsed.toString();
  } catch {
    issues.push(`WEB_SEARCH_ENDPOINT is not a valid URL: ${JSON.stringify(webSearchEndpoint)}`);
  }

  const webSearchAuthHeader = WEB_SEARCH_AUTH_HEADERS.find(
    (candidate) => candidate.toLowerCase() === String(raw.webSearchAuthHeader || 'X-API-KEY').toLowerCase(),
  );
  if (!webSearchAuthHeader) {
    issues.push(
      `WEB_SEARCH_AUTH_HEADER must be one of ${WEB_SEARCH_AUTH_HEADERS.join(', ')} (received ${JSON.stringify(raw.webSearchAuthHeader)})`,
    );
  }

  const webSearchEnabled = toBoolDefault('WEB_SEARCH_ENABLED', raw.webSearchEnabled, issues, true);
  const webSearchFallback = toBoolDefault('WEB_SEARCH_FALLBACK', raw.webSearchFallback, issues, true);
  const webMcpDebug = toBoolDefault('WEB_MCP_DEBUG', raw.webMcpDebug, issues, false);
  const duckduckgoMcpEnabled = toBoolDefault('DUCKDUCKGO_MCP_ENABLED', raw.duckduckgoMcpEnabled, issues, false);
  const youApiKey = optionalKey('YDC_API_KEY', raw.youApiKey, warnings);
  const firecrawlApiKey = optionalKey('FIRECRAWL_API_KEY', raw.firecrawlApiKey, warnings);
  const tavilyApiKey = optionalKey('TAVILY_API_KEY', raw.tavilyApiKey, warnings);

  const explicitOrder = parseProviderList('WEB_SEARCH_PROVIDERS', raw.webSearchProviders, issues);
  const webSearchProviders = explicitOrder ?? [
    ...(webSearchApiKey ? ['serper'] : []),
    ...WEB_PROVIDER_DEFAULT,
  ];
  const webSearchDisabled = parseProviderList('WEB_SEARCH_DISABLED', raw.webSearchDisabled, issues) || [];
  if (webSearchProviders.length === 0) {
    warnings.push('WEB_SEARCH_PROVIDERS is empty; web search is registered but no provider will be tried.');
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
    warnings.push('AGENT_MAX_OUTPUT_TOKENS is high; the selected model may reject it or bill more aggressively.');
  }
  if (values.maxSteps > 50) {
    warnings.push('AGENT_MAX_STEPS is high; long autonomous runs cost more tokens and time.');
  }

  const allowShell = toBool('AGENT_ALLOW_SHELL', raw.allowShell, issues);
  const debug = raw.debug === true || raw.debug === 'true' || raw.debug === '1';
  if (allowShell) {
    warnings.push('AGENT_ALLOW_SHELL=true enables shell syntax after explicit approval. Shell execution is NOT a sandbox.');
  }

  const stateRoot = path.join(workspace, '.ryuu');
  const historyDir = resolveDir(raw.historyDir, workspace, 'AGENT_HISTORY_DIR', issues) || path.join(stateRoot, 'sessions');
  const logDir = resolveDir(raw.logDir, workspace, 'AGENT_LOG_DIR', issues) || path.join(stateRoot, 'logs');
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
  return {
    provider: 'NVIDIA Integrate API (OpenAI-compatible)',
    baseURL: config.baseURL,
    model: config.model,
    apiKey: config.apiKey ? 'set (redacted)' : '(not set)',
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
      ? 'disabled (WEB_SEARCH_ENABLED=false)'
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
