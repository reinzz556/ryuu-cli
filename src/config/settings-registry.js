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
  maxSteps: { env: 'AGENT_MAX_STEPS', description: 'Optional cap on agent steps per task (0 = unlimited).' },
  maxOutputTokens: { env: 'AGENT_MAX_OUTPUT_TOKENS', description: 'Maximum tokens the model may emit per response.' },
  requestTimeoutMs: { env: 'AGENT_REQUEST_TIMEOUT_MS', description: 'Timeout for one model request, in milliseconds.' },
  streamIdleTimeoutMs: { env: 'AGENT_STREAM_IDLE_TIMEOUT_MS', description: 'Abort a response stream idle for this long (0 disables).' },
  maxRetries: { env: 'AGENT_MAX_RETRIES', description: 'Transport retries per model request.' },
  maxRecoveryAttempts: { env: 'AGENT_MAX_RECOVERY_ATTEMPTS', description: 'Heartbeat reconnect attempts after a provider failure (0 = unlimited).' },
  recoveryBackoffMs: { env: 'AGENT_RECOVERY_BACKOFF_MS', description: 'First heartbeat reconnect delay, in milliseconds.' },
  maxFileBytes: { env: 'AGENT_MAX_FILE_BYTES', description: 'Largest file read in full, in bytes.' },
  maxSearchResults: { env: 'AGENT_MAX_SEARCH_RESULTS', description: 'Maximum matches returned by search_files.' },
  maxToolOutputBytes: { env: 'AGENT_MAX_TOOL_OUTPUT_BYTES', description: 'Maximum captured tool/command output, in bytes.' },
  maxTaskDurationMs: { env: 'AGENT_MAX_TASK_DURATION_MS', description: 'Wall-clock budget for one task, in milliseconds.' },
  maxContextChars: { env: 'AGENT_MAX_CONTEXT_CHARS', description: 'Local context budget before older exchanges are compacted.' },
  approvalPolicy: {
    env: 'AGENT_APPROVAL_POLICY',
    description: 'Approval gate: ask for every change, auto-approve writes, or deny all writes and commands.',
    choices: APPROVAL_POLICIES,
    default: 'ask',
  },
  logLevel: {
    env: 'LOG_LEVEL',
    description: 'Log verbosity.',
    choices: LOG_LEVELS,
    default: 'info',
  },
};

const WEB_META = {
  serperApiKey: { env: 'SEARCH_API_KEY', description: 'Serper API key for web_search (optional).' },
  youApiKey: { env: 'YDC_API_KEY', description: 'You.com API key for web_search (optional).' },
  firecrawlApiKey: { env: 'FIRECRAWL_API_KEY', description: 'Firecrawl API key for web_search (optional).' },
  tavilyApiKey: { env: 'TAVILY_API_KEY', description: 'Tavily API key for web_search (optional).' },
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
    envVar: null,
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
export function buildSettingsRegistry({ providers = [], settings = {}, customModels = {}, env = {} } = {}) {
  const entries = [];
  const providerIds = providers.map((provider) => provider.id);

  entries.push(
    descriptor({
      key: 'provider',
      label: 'DEFAULT_PROVIDER',
      description: 'Provider used by default. "auto" picks the first provider with a key (NVIDIA preferred).',
      type: 'provider',
      value: settingsProviderId(settings),
      choices: ['auto', ...providerIds],
      envVar: 'RYUU_PROVIDER',
      validate: (value) => validateProvider(value, providerIds),
    }),
  );

  for (const provider of providers) {
    const stored = settings.providers?.[provider.id] || {};
    const upper = provider.id.toUpperCase();
    const modelChoices = [
      ...new Set([
        ...(provider.models || []).map((entry) => entry.id),
        ...(customModels[provider.id] || []),
      ]),
    ];
    entries.push(
      descriptor({
        key: `providers.${provider.id}.apiKey`,
        label: provider.apiKeyEnv || `${upper}_API_KEY`,
        description: `API key for ${provider.name}${provider.docsUrl ? ` — ${provider.docsUrl}` : ''}. Masked in every list and written owner-only.`,
        type: 'secret',
        secret: true,
        value: typeof stored.apiKey === 'string' ? stored.apiKey : '',
        envVar: provider.apiKeyEnv,
        validate: validateSecret,
      }),
    );
    entries.push(
      descriptor({
        key: `providers.${provider.id}.baseURL`,
        label: provider.baseUrlEnv || `${upper}_BASE_URL`,
        description: `Base URL for ${provider.name}. Empty uses ${provider.baseURL}.`,
        type: 'url',
        value: typeof stored.baseURL === 'string' ? stored.baseURL : '',
        defaultValue: provider.baseURL,
        envVar: provider.baseUrlEnv,
        validate: (value) => validateUrl(value, 'Base URL'),
      }),
    );
    entries.push(
      descriptor({
        key: `providerModel.${provider.id}`,
        label: `MODEL[${provider.id}]`,
        description: `Model used with ${provider.name}. Empty uses ${provider.defaultModel}.`,
        type: 'model',
        value: settingsModelFor(settings, provider.id),
        defaultValue: provider.defaultModel,
        choices: modelChoices,
        envVar: provider.modelEnv || null,
        validate: (value) => validateModel(value, { providerId: provider.id, choices: modelChoices }),
      }),
    );
  }

  for (const key of Object.keys(AGENT_META)) {
    const meta = AGENT_META[key];
    const field = `agent.${key}`;
    if (meta.choices) {
      entries.push(
        descriptor({
          key: field,
          label: meta.env,
          description: meta.description,
          type: 'enum',
          choices: meta.choices,
          value: getSetting(settings, field) ?? meta.default,
          defaultValue: meta.default,
          envVar: meta.env,
          validate: (value) => {
            const text = String(value ?? '').trim().toLowerCase();
            if (!meta.choices.includes(text)) {
              return fail(`${meta.env} must be one of ${meta.choices.join(', ')}.`);
            }
            return ok(text);
          },
        }),
      );
      continue;
    }
    const limits = CONFIG_LIMITS[key];
    if (!limits) continue;
    const [min, max, fallback] = limits;
    entries.push(
      descriptor({
        key: field,
        label: meta.env,
        description: meta.description,
        type: 'integer',
        min,
        max,
        value: getSetting(settings, field) ?? fallback,
        defaultValue: fallback,
        envVar: meta.env,
        validate: (value) => validateInteger(value, { min, max, label: meta.env }),
      }),
    );
  }

  for (const [key, meta] of Object.entries(WEB_META)) {
    entries.push(
      descriptor({
        key: `webSearch.${key}`,
        label: meta.env,
        description: meta.description,
        type: 'secret',
        secret: true,
        value: getSetting(settings, `webSearch.${key}`) ?? '',
        envVar: meta.env,
        validate: validateSecret,
      }),
    );
  }
  const resultsLimits = CONFIG_LIMITS.webSearchResults;
  entries.push(
    descriptor({
      key: 'webSearch.results',
      label: 'WEB_SEARCH_RESULTS',
      description: 'Results requested per web search.',
      type: 'integer',
      min: resultsLimits[0],
      max: resultsLimits[1],
      value: getSetting(settings, 'webSearch.results') ?? resultsLimits[2],
      defaultValue: resultsLimits[2],
      envVar: 'WEB_SEARCH_RESULTS',
      validate: (value) =>
        validateInteger(value, { min: resultsLimits[0], max: resultsLimits[1], label: 'WEB_SEARCH_RESULTS' }),
    }),
  );
  const timeoutLimits = CONFIG_LIMITS.webSearchTimeoutMs;
  entries.push(
    descriptor({
      key: 'webSearch.timeoutMs',
      label: 'WEB_SEARCH_TIMEOUT_MS',
      description: 'Timeout for one web search request, in milliseconds.',
      type: 'integer',
      min: timeoutLimits[0],
      max: timeoutLimits[1],
      value: getSetting(settings, 'webSearch.timeoutMs') ?? timeoutLimits[2],
      defaultValue: timeoutLimits[2],
      envVar: 'WEB_SEARCH_TIMEOUT_MS',
      validate: (value) =>
        validateInteger(value, { min: timeoutLimits[0], max: timeoutLimits[1], label: 'WEB_SEARCH_TIMEOUT_MS' }),
    }),
  );
  const defaultOrder = ['you', 'firecrawl', 'duckduckgo', 'tavily'];
  entries.push(
    descriptor({
      key: 'webSearch.providers',
      label: 'WEB_SEARCH_PROVIDERS',
      description: 'Web search providers tried in order. Comma-separated; "none" disables all.',
      type: 'list',
      choices: WEB_PROVIDER_IDS,
      value: getSetting(settings, 'webSearch.providers') ?? defaultOrder,
      defaultValue: defaultOrder,
      envVar: 'WEB_SEARCH_PROVIDERS',
      validate: validateWebProviderList,
    }),
  );

  return entries.map((entry) => ({
    ...entry,
    // An env var that is already set beats the file, so the editor can say so.
    envOverride: Boolean(entry.envVar && env[entry.envVar]),
  }));
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
  if (entry.envVar) bits.push(`${entry.envVar} wins over this file when set`);
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
