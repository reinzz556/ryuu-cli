import {
  getSetting,
  maskSettingsSecret,
  settingsModelFor,
  settingsProviderId,
} from './settings.js';
import { APPROVAL_POLICIES, CONFIG_LIMITS, LOG_LEVELS } from './validate.js';
import { MAX_MODEL_ID_LENGTH, MODEL_ID_PATTERN, normalizeProviderId } from '../providers/catalog.js';

/**
 * The editable settings registry.
 *
 * One descriptor per user-editable value, built from the provider catalog and
 * the same limits/defaults startup validation uses. The numbered editor and the
 * settings TUI both render this list, so there is a single source of truth for
 * labels, defaults, secret masking and validation.
 */

const WEB_PROVIDER_IDS = ['serper', 'you', 'firecrawl', 'duckduckgo', 'tavily'];
const PLACEHOLDER_KEY = /^(your[_-]?.*api[_-]?key|changeme|replace[_-]?me|<.*>)$/i;

const AGENT_META = {
  maxSteps: { description: 'Optional cap on agent steps per task (0 = unlimited).' },
  maxOutputTokens: { description: 'Maximum tokens the model may emit per response.' },
  requestTimeoutMs: { description: 'Timeout for one model request, in milliseconds.' },
  streamIdleTimeoutMs: { description: 'Abort a response stream idle for this long (0 disables).' },
  maxRetries: { description: 'Transport retries per model request.' },
  maxRecoveryAttempts: { description: 'Heartbeat reconnect attempts after a provider failure (0 = unlimited).' },
  recoveryBackoffMs: { description: 'First heartbeat reconnect delay, in milliseconds.' },
  maxFileBytes: { description: 'Largest file read in full, in bytes.' },
  maxSearchResults: { description: 'Maximum matches returned by search_files.' },
  maxToolOutputBytes: { description: 'Maximum captured tool/command output, in bytes.' },
  maxTaskDurationMs: { description: 'Wall-clock budget for one task, in milliseconds.' },
  maxContextChars: { description: 'Local context budget before older exchanges are compacted.' },
  approvalPolicy: {
    description: 'Approval gate: ask for every change, auto-approve writes, or deny all writes and commands.',
    choices: APPROVAL_POLICIES,
    default: 'ask',
  },
  logLevel: {
    description: 'Log verbosity.',
    choices: LOG_LEVELS,
    default: 'info',
  },
  allowShell: {
    description: 'Allow shell syntax in run_command after explicit approval. Not a sandbox.',
    boolean: true,
  },
  debug: { description: 'Verbose logs and stack traces.', boolean: true },
  historyDir: { description: 'Session history directory, relative to the workspace (empty uses .ryuu/sessions).' },
  logDir: { description: 'Log directory, relative to the workspace (empty uses .ryuu/logs).' },
};

const WEB_BOOLEAN_KEYS = ['enabled', 'fallback', 'debug', 'duckduckgoEnabled'];

const WEB_META = {
  serperApiKey: { description: 'Serper API key for web_search (optional).' },
  youApiKey: { description: 'You.com API key for web_search (optional).' },
  firecrawlApiKey: { description: 'Firecrawl API key for web_search (optional).' },
  tavilyApiKey: { description: 'Tavily API key for web_search (optional).' },
  endpoint: { description: 'Serper-compatible search endpoint.', type: 'url' },
  authHeader: {
    description: 'Header that carries the Serper-compatible search key.',
    choices: ['X-API-KEY', 'Authorization'],
    default: 'X-API-KEY',
  },
  enabled: { description: 'Register the web_search tool at all.', boolean: true, default: true },
  fallback: { description: 'Fall back to the next web search provider when one fails.', boolean: true, default: true },
  debug: { description: 'Extra web search diagnostics in the log (never prints keys).', boolean: true },
  duckduckgoEnabled: {
    description: 'Enable the local DuckDuckGo MCP server (runs third-party code via uvx).',
    boolean: true,
  },
  duckduckgoCommand: { description: 'Command used to start the DuckDuckGo MCP server (default: uvx).' },
  duckduckgoArgs: { description: 'Arguments for the DuckDuckGo MCP command (default: free-search-mcp).' },
};

function ok(value, warning = null) {
  return { ok: true, value, warning };
}

function fail(error) {
  return { ok: false, error };
}

function validateText(value, { allowEmpty = true, max = 4096 } = {}) {
  if (typeof value !== 'string') return fail('Expected text.');
  const text = value.trim();
  if (!text && !allowEmpty) return fail('A value is required.');
  if (text.length > max) return fail(`Value is too long (maximum ${max} characters).`);
  if (/[\u0000-\u001f\u007f]/.test(text)) return fail('Control characters are not allowed.');
  return ok(text);
}

/** Keys are never sent anywhere to be checked; only local format rules apply. */
function validateSecret(value) {
  const base = validateText(value);
  if (!base.ok) return base;
  const text = base.value;
  if (!text) return base;
  if (/\s/.test(text)) return fail('A key cannot contain spaces or line breaks.');
  if (PLACEHOLDER_KEY.test(text)) return fail('That looks like a placeholder, not a real key.');
  return ok(text);
}

function validateUrl(value, label) {
  const base = validateText(value);
  if (!base.ok) return base;
  const text = base.value;
  if (!text) return base;
  try {
    const parsed = new URL(text);
    if (!['http:', 'https:'].includes(parsed.protocol)) return fail(`${label} must use http or https.`);
    if (parsed.username || parsed.password) return fail(`${label} must not embed credentials.`);
    return ok(parsed.toString().replace(/\/$/, ''));
  } catch {
    return fail(`${label} is not a valid URL.`);
  }
}

function validateInteger(value, { min, max, label }) {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!text) return fail(`${label} needs a number.`);
  if (!/^-?\d+$/.test(text)) return fail(`${label} must be an integer.`);
  const number = Number(text);
  if (!Number.isSafeInteger(number)) return fail(`${label} is outside the supported range.`);
  if (number < min || number > max) return fail(`${label} must be between ${min} and ${max}.`);
  return ok(number);
}

function validateProvider(value, ids) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text || text === 'auto') return ok(null);
  const id = normalizeProviderId(text);
  if (!id || !ids.includes(id)) {
    return fail(`Unknown provider ${JSON.stringify(text)}. Choose one of: ${ids.join(', ')} (or "auto").`);
  }
  return ok(id);
}

function validateModel(value, { providerId, choices }) {
  const text = String(value ?? '').trim();
  if (!text) return fail('A model id is required.');
  if (text.length > MAX_MODEL_ID_LENGTH || !MODEL_ID_PATTERN.test(text)) {
    return fail('Model id contains unsupported characters.');
  }
  if (choices.length > 0 && !choices.includes(text)) {
    return ok(text, `Model ${text} is not in the ${providerId} catalog; it will be sent as-is and may fail.`);
  }
  return ok(text);
}

function validateWebProviderList(value) {
  const items = Array.isArray(value) ? value : String(value ?? '').split(/[\s,]+/);
  const ids = [];
  for (const item of items) {
    const id = String(item ?? '').trim().toLowerCase();
    if (!id) continue;
    if (id === 'none' || id === 'off') return ok([]);
    if (!WEB_PROVIDER_IDS.includes(id)) {
      return fail(`Unknown web search provider ${JSON.stringify(id)} (allowed: ${WEB_PROVIDER_IDS.join(', ')}).`);
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return ok(ids);
}

function descriptor(entry) {
  return {
    editable: true,
    required: false,
    secret: false,
    type: 'text',
    choices: null,
    min: null,
    max: null,
    defaultValue: null,
    ...entry,
  };
}

/**
 * Build the settings list for the given provider catalog and file contents.
 *
 * `providers` comes from the provider catalog (`buildProviders`), so user-added
 * providers get their own key/base URL/model entries without a parallel list.
 */
export function buildSettingsRegistry({ providers = [], settings = {}, customModels = {} } = {}) {
  const entries = [];
  const providerIds = providers.map((provider) => provider.id);

  entries.push(
    descriptor({
      key: 'provider',
      label: 'provider',
      description: 'Provider used by default. "auto" picks the first provider with a key (NVIDIA preferred).',
      type: 'provider',
      value: settingsProviderId(settings),
      choices: ['auto', ...providerIds],
      validate: (value) => validateProvider(value, providerIds),
    }),
  );

  for (const provider of providers) {
    const stored = settings.providers?.[provider.id] || {};
    const keyPath = `providers.${provider.id}.apiKey`;
    const urlPath = `providers.${provider.id}.baseURL`;
    const modelPath = `providerModel.${provider.id}`;
    const modelChoices = [
      ...new Set([
        ...(provider.models || []).map((entry) => entry.id),
        ...(customModels[provider.id] || []),
      ]),
    ];
    entries.push(
      descriptor({
        key: keyPath,
        label: keyPath,
        description: `API key for ${provider.name}${provider.docsUrl ? ` — ${provider.docsUrl}` : ''}. Masked in every list and written owner-only.`,
        type: 'secret',
        secret: true,
        value: typeof stored.apiKey === 'string' ? stored.apiKey : '',
        validate: validateSecret,
      }),
    );
    entries.push(
      descriptor({
        key: urlPath,
        label: urlPath,
        description: `Base URL for ${provider.name}. Empty uses ${provider.baseURL}.`,
        type: 'url',
        value: typeof stored.baseURL === 'string' ? stored.baseURL : '',
        defaultValue: provider.baseURL,
        validate: (value) => validateUrl(value, 'Base URL'),
      }),
    );
    entries.push(
      descriptor({
        key: modelPath,
        label: modelPath,
        description: `Model used with ${provider.name}. Empty uses ${provider.defaultModel}.`,
        type: 'model',
        value: settingsModelFor(settings, provider.id),
        defaultValue: provider.defaultModel,
        choices: modelChoices,
        validate: (value) => validateModel(value, { providerId: provider.id, choices: modelChoices }),
      }),
    );
  }

  const pushBoolean = (field, meta) => {
    const fallback = meta.default ?? false;
    entries.push(
      descriptor({
        key: field,
        label: field,
        description: meta.description,
        type: 'enum',
        choices: ['true', 'false'],
        value: getSetting(settings, field) ?? fallback,
        defaultValue: fallback,
        validate: (value) => {
          const text = String(value ?? '').trim().toLowerCase();
          if (text === 'true') return ok(true);
          if (text === 'false') return ok(false);
          return fail(`${field} must be true or false.`);
        },
      }),
    );
  };

  const pushInteger = (field, limits, description) => {
    const [min, max, fallback] = limits;
    entries.push(
      descriptor({
        key: field,
        label: field,
        description,
        type: 'integer',
        min,
        max,
        value: getSetting(settings, field) ?? fallback,
        defaultValue: fallback,
        validate: (value) => validateInteger(value, { min, max, label: field }),
      }),
    );
  };

  for (const key of Object.keys(AGENT_META)) {
    const meta = AGENT_META[key];
    const field = `agent.${key}`;
    if (meta.boolean) {
      pushBoolean(field, meta);
      continue;
    }
    if (meta.choices) {
      entries.push(
        descriptor({
          key: field,
          label: field,
          description: meta.description,
          type: 'enum',
          choices: meta.choices,
          value: getSetting(settings, field) ?? meta.default,
          defaultValue: meta.default,
          validate: (value) => {
            const text = String(value ?? '').trim().toLowerCase();
            if (!meta.choices.includes(text)) {
              return fail(`${field} must be one of ${meta.choices.join(', ')}.`);
            }
            return ok(text);
          },
        }),
      );
      continue;
    }
    const limits = CONFIG_LIMITS[key];
    if (limits) {
      pushInteger(field, limits, meta.description);
      continue;
    }
    entries.push(
      descriptor({
        key: field,
        label: field,
        description: meta.description,
        type: 'text',
        value: getSetting(settings, field) ?? '',
        validate: (value) => validateText(value),
      }),
    );
  }

  for (const [key, meta] of Object.entries(WEB_META)) {
    const field = `webSearch.${key}`;
    if (WEB_BOOLEAN_KEYS.includes(key)) {
      pushBoolean(field, meta);
      continue;
    }
    if (meta.choices) {
      entries.push(
        descriptor({
          key: field,
          label: field,
          description: meta.description,
          type: 'enum',
          choices: meta.choices,
          value: getSetting(settings, field) ?? meta.default,
          defaultValue: meta.default,
          validate: (value) => {
            const text = String(value ?? '').trim();
            const match = meta.choices.find((choice) => choice.toLowerCase() === text.toLowerCase());
            return match ? ok(match) : fail(`${field} must be one of ${meta.choices.join(', ')}.`);
          },
        }),
      );
      continue;
    }
    if (meta.type === 'url') {
      entries.push(
        descriptor({
          key: field,
          label: field,
          description: meta.description,
          type: 'url',
          value: getSetting(settings, field) ?? '',
          defaultValue: 'https://google.serper.dev/search',
          validate: (value) => validateUrl(value, field),
        }),
      );
      continue;
    }
    if (key.endsWith('ApiKey')) {
      entries.push(
        descriptor({
          key: field,
          label: field,
          description: meta.description,
          type: 'secret',
          secret: true,
          value: getSetting(settings, field) ?? '',
          validate: validateSecret,
        }),
      );
      continue;
    }
    entries.push(
      descriptor({
        key: field,
        label: field,
        description: meta.description,
        type: 'text',
        value: getSetting(settings, field) ?? '',
        validate: (value) => validateText(value),
      }),
    );
  }
  pushInteger('webSearch.results', CONFIG_LIMITS.webSearchResults, 'Results requested per web search.');
  pushInteger('webSearch.timeoutMs', CONFIG_LIMITS.webSearchTimeoutMs, 'Timeout for one web search request, in milliseconds.');
  pushInteger('webSearch.mcpTimeoutMs', CONFIG_LIMITS.webMcpTimeoutMs, 'Timeout for one MCP web search call, in milliseconds.');
  pushInteger('webSearch.mcpMaxRetries', CONFIG_LIMITS.webMcpMaxRetries, 'Bounded retries for transient MCP web search failures.');
  const defaultOrder = ['you', 'firecrawl', 'duckduckgo', 'tavily'];
  entries.push(
    descriptor({
      key: 'webSearch.providers',
      label: 'webSearch.providers',
      description: 'Web search providers tried in order. Comma-separated; "none" disables all.',
      type: 'list',
      choices: WEB_PROVIDER_IDS,
      value: getSetting(settings, 'webSearch.providers') ?? defaultOrder,
      defaultValue: defaultOrder,
      validate: validateWebProviderList,
    }),
  );
  entries.push(
    descriptor({
      key: 'webSearch.disabled',
      label: 'webSearch.disabled',
      description: 'Web search providers to skip even when listed in the order.',
      type: 'list',
      choices: WEB_PROVIDER_IDS,
      value: getSetting(settings, 'webSearch.disabled') ?? [],
      defaultValue: [],
      validate: validateWebProviderList,
    }),
  );

  return entries;
}

/** Look a setting up by 1-based list number or by key/label (case-insensitive). */
export function findSetting(registry = [], reference, { allowKey = false } = {}) {
  const text = String(reference ?? '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const index = Number(text);
    return index >= 1 && index <= registry.length ? registry[index - 1] : null;
  }
  if (!allowKey) return null;
  return (
    registry.find((entry) => entry.key === text || entry.label.toLowerCase() === text.toLowerCase()) || null
  );
}

/** Display value; secrets are always masked and never reveal their length. */
export function formatSettingValue(entry) {
  if (!entry) return '';
  if (entry.secret) return maskSettingsSecret(entry.value);
  const value = entry.value;
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '(none)';
  if (value === null || value === undefined || value === '') {
    if (entry.type === 'provider') return '(auto)';
    if (entry.defaultValue !== null && entry.defaultValue !== undefined && entry.defaultValue !== '') {
      return `${formatDefault(entry)} (default)`;
    }
    return '(not set)';
  }
  return String(value);
}

function formatDefault(entry) {
  return Array.isArray(entry.defaultValue) ? entry.defaultValue.join(', ') : String(entry.defaultValue);
}

/** Human-readable constraints for the selected setting (TUI detail pane). */
export function describeSetting(entry) {
  if (!entry) return '';
  const bits = [];
  if (entry.type === 'integer') bits.push(`integer ${entry.min}–${entry.max}`);
  if (entry.type === 'secret') bits.push('masked');
  if (entry.choices?.length) {
    const choices = entry.choices.length > 8 ? `${entry.choices.slice(0, 8).join(', ')}, …` : entry.choices.join(', ');
    bits.push(`${entry.type === 'model' ? 'catalog' : 'choices'}: ${choices}`);
  }
  if (!entry.secret && entry.defaultValue !== null && entry.defaultValue !== undefined && entry.defaultValue !== '') {
    bits.push(`default: ${formatDefault(entry)}`);
  }
  return bits.join(' · ');
}

/** Apply one raw editor value through the descriptor's validator. */
export function validateSetting(entry, rawValue) {
  if (!entry) return fail('Unknown setting.');
  try {
    return entry.validate(rawValue);
  } catch (error) {
    return fail(error?.message || 'Invalid value.');
  }
}

/** The value to store for a descriptor: validator output, not raw text. */
export function normalizeSettingValue(entry, rawValue) {
  const result = validateSetting(entry, rawValue);
  return result;
}
