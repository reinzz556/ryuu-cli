import { ConfigError } from '../utils/errors.js';
import { getSetting } from './settings.js';

// The provider/model catalog lives with the providers; re-exported here so the
// existing import sites (and the documented defaults) keep one location.
export { DEFAULT_BASE_URL, DEFAULT_MODEL, MODEL_CATALOG } from '../providers/catalog.js';

/**
 * config.json `agent` keys mapped to their raw-config names. The names are the
 * same on purpose: one vocabulary for the file, the settings editor and the
 * validated config.
 */
export const AGENT_SETTING_KEYS = [
  'maxSteps',
  'maxOutputTokens',
  'requestTimeoutMs',
  'streamIdleTimeoutMs',
  'maxRetries',
  'maxRecoveryAttempts',
  'recoveryBackoffMs',
  'maxFileBytes',
  'maxSearchResults',
  'maxToolOutputBytes',
  'maxTaskDurationMs',
  'maxContextChars',
  'approvalPolicy',
  'logLevel',
  'allowShell',
  'debug',
  'historyDir',
  'logDir',
];

/**
 * config.json `webSearch` keys mapped to the raw-config key they fill.
 *
 * `duckduckgoEnabled`, `duckduckgoCommand` and `duckduckgoArgs` are stored
 * flat under `webSearch` for a simpler editor row each.
 */
export const WEB_SETTING_KEYS = {
  serperApiKey: 'webSearchApiKey',
  youApiKey: 'youApiKey',
  firecrawlApiKey: 'firecrawlApiKey',
  tavilyApiKey: 'tavilyApiKey',
  results: 'webSearchResults',
  timeoutMs: 'webSearchTimeoutMs',
  providers: 'webSearchProviders',
  enabled: 'webSearchEnabled',
  fallback: 'webSearchFallback',
  disabled: 'webSearchDisabled',
  endpoint: 'webSearchEndpoint',
  authHeader: 'webSearchAuthHeader',
  mcpTimeoutMs: 'webMcpTimeoutMs',
  mcpMaxRetries: 'webMcpMaxRetries',
  debug: 'webMcpDebug',
  duckduckgoEnabled: 'duckduckgoMcpEnabled',
  duckduckgoCommand: 'duckduckgoMcpCommand',
  duckduckgoArgs: 'duckduckgoMcpArgs',
};

/** A list setting is stored as an array but validated as a comma list. */
function rawListValue(value) {
  if (!Array.isArray(value)) return value;
  return value.length > 0 ? value.join(',') : 'none';
}

/**
 * Build a raw, unvalidated config object from the user's config.json contents.
 *
 * This is the only configuration source: no `.env`, no environment variables.
 * CLI flags are applied on top by the entry point, and the workspace's
 * `.ryuu/preferences.json` supplies the last `/provider` and `/model` choices.
 */
export function buildRawConfig(settings = {}, { cwd = process.cwd() } = {}) {
  const data = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};

  // One credentials entry per provider: the key, the base URL override and the
  // model chosen in `providerModel`. Providers without stored values still get
  // their catalog defaults from `buildProviders`.
  const credentials = {};
  const storedProviders = data.providers && typeof data.providers === 'object' ? data.providers : {};
  for (const [id, stored] of Object.entries(storedProviders)) {
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) continue;
    credentials[id] = {
      apiKey: typeof stored.apiKey === 'string' ? stored.apiKey : '',
      baseURL: typeof stored.baseURL === 'string' ? stored.baseURL : '',
      model: '',
    };
    // Per-provider request overrides (River's `reasoningEffort`, a
    // pass-through `extraBody`, ...) are stored next to the key.
    for (const field of ['reasoningEffort', 'thinking', 'extraBody', 'requestParams']) {
      if (stored[field] !== undefined) credentials[id][field] = stored[field];
    }
  }
  const storedModels = data.providerModel && typeof data.providerModel === 'object' ? data.providerModel : {};
  for (const [id, model] of Object.entries(storedModels)) {
    if (typeof model !== 'string') continue;
    if (!credentials[id]) credentials[id] = { apiKey: '', baseURL: '', model: '' };
    credentials[id].model = model;
  }

  const raw = {
    provider: typeof data.provider === 'string' ? data.provider : null,
    model: null,
    providerCredentials: credentials,
    extraProviders: data.extraProviders ?? null,
    workspace: '.',
    cwd,
  };
  for (const key of AGENT_SETTING_KEYS) {
    raw[key] = getSetting(data, `agent.${key}`);
  }
  for (const [settingsKey, rawKey] of Object.entries(WEB_SETTING_KEYS)) {
    const value = getSetting(data, `webSearch.${settingsKey}`);
    raw[rawKey] = rawListValue(value);
  }
  // The selected model comes from the same place the editor writes it.
  const activeProvider = typeof raw.provider === 'string' ? raw.provider.trim().toLowerCase() : '';
  if (activeProvider) raw.model = getSetting(data, `providerModel.${activeProvider}`) ?? null;
  return raw;
}

/** Verify the Node.js runtime is new enough for the APIs used here. */
export function checkRuntime({ nodeVersion = process.versions.node } = {}) {
  const major = Number.parseInt(nodeVersion.split('.')[0], 10);
  const warnings = [];
  if (!Number.isFinite(major) || major < 22) {
    throw new ConfigError(
      `Node.js ${nodeVersion} is too old. Ryuu Agent CLI requires Node.js 22+ (target: Node.js 25.x).`,
      { nodeVersion },
    );
  }
  if (major < 25) {
    warnings.push(`Node.js ${nodeVersion} detected. Ryuu Agent CLI targets Node.js 25.x; older majors are untested.`);
  }
  return { major, warnings };
}
