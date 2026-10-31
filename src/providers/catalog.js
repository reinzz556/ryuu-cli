/**
 * Provider catalog.
 *
 * This is the single place that declares which AI providers and models Ryuu CLI
 * knows about. The agent core never names a provider: it asks a descriptor for
 * the base URL, credentials, model list and capabilities, and talks to every
 * OpenAI-compatible endpoint through the same client.
 *
 * Adding a provider here (or with `extraProviders` in config.json) is enough;
 * no agent code changes are needed. The model list is the set of ids the CLI
 * offers, not a guarantee that the provider currently serves them.
 */

/** ID used when nothing else selects a provider. */
export const DEFAULT_PROVIDER_ID = 'nvidia';

export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
export const MAX_MODEL_ID_LENGTH = 200;

/** NVIDIA Integrate API catalog, in the order `/model` lists (and numbers) it. */
export const MODEL_CATALOG = [
  'nvidia/nemotron-3.5-super-vl-120b-a12b',
  'z-ai/glm-5.3-flash',
  'google/diffusiongemma-26b-a4b-it',
  'poolside/laguna-xs-2.1',
  'stepfun-ai/step-5-preview',
  'minimaxai/minimax-m3.1-flash', // default, listed 6th on purpose
];

/**
 * Model the provider starts with. Kept separate from the list order so the
 * default can be any entry without renumbering `/model`.
 */
export const DEFAULT_MODEL = 'minimaxai/minimax-m3.1-flash';
export const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';

export const TOKENHARBOR_BASE_URL = 'https://tokenharbor.ai/v1';
export const TOKENHARBOR_MODEL = 'deepseek-v4.1-flash:free';

export const RIVER_BASE_URL = 'https://api.river.ai/v1';
export const RIVER_PROVIDER_ID = 'river';
export const RIVER_DOCS_URL = 'https://docs.river.ai/guides/inference-controls/';

/** River's documented `reasoning_effort` menu, lowest to highest. */
export const RIVER_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
/** Used when thinking is enabled without an explicit level (River's own rule). */
export const RIVER_DEFAULT_REASONING_EFFORT = 'high';

/** Model ids `/model` offers for River, default first. */
export const RIVER_MODEL_CATALOG = [
  'deepseek-ai/DeepSeek-V4.1-Flash-1017',
  'deepseek-ai/DeepSeek-V4.1-Flash',
  'zai-org/GLM-5.3-Flash',
  'GLM-5.3',
  'Qwen/Qwen3.8-27B-FP8',
  'nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4',
  'nvidia/GLM-5.2-NVFP4',
  'nvidia/GLM-5.2-NVFP4-262K',
  'nvidia/Kimi-K2.6-NVFP4',
  'nvidia/Kimi-K2.6-NVFP4-262K',
  'nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4',
  'Qwen/Qwen3.5-9B',
  'Qwen/Qwen3.5-122B-A10B-FP8',
  'Qwen/Qwen3.5-397B-A17B-FP8',
  'Qwen/Qwen3.6-35B-A3B-FP8',
  'XiaomiMiMo/MiMo-V2.6-Flash-RL',
  'XiaomiMiMo/MiMo-V2.6-Pro-RL',
];
export const RIVER_DEFAULT_MODEL = RIVER_MODEL_CATALOG[0];

/** Per-provider request fields a config.json override may carry verbatim. */
export const PROVIDER_REQUEST_FIELDS = ['reasoningEffort', 'extraBody', 'requestParams', 'thinking'];

/**
 * Built-in providers, in fallback order for key auto-detection.
 *
 * Credentials and per-provider overrides live in the user's config.json, never
 * in this catalog: `buildProviders` merges the stored values into a copy.
 *
 * `capabilities` is advisory: the agent only relies on it to decide whether to
 * send tools and whether to request a stream. Reasoning is never assumed —
 * reasoning fields are read from the response when the provider sends them.
 */
export const BUILTIN_PROVIDERS = [
  {
    id: 'nvidia',
    name: 'NVIDIA Integrate API',
    apiFormat: 'openai-chat-completions',
    baseURL: DEFAULT_BASE_URL,
    defaultModel: DEFAULT_MODEL,
    models: MODEL_CATALOG.map((id) => ({ id, name: id, ...(id === DEFAULT_MODEL ? { default: true } : {}) })),
    capabilities: { streaming: true, tools: true, reasoning: true, multimodal: true },
    docsUrl: 'https://build.nvidia.com/',
  },
  {
    id: 'tokenharbor',
    name: 'Token Harbor',
    apiFormat: 'openai-chat-completions',
    baseURL: TOKENHARBOR_BASE_URL,
    defaultModel: TOKENHARBOR_MODEL,
    models: [{ id: TOKENHARBOR_MODEL, name: 'DeepSeek V4.1 Flash Free', default: true }],
    capabilities: { streaming: true, tools: true, reasoning: true, multimodal: false },
    docsUrl: 'https://tokenharbor.ai/',
  },
  {
    // River keeps thinking off by default for its DeepSeek models, so the
    // dedicated client (providers/river.js) adds `reasoning_effort` to the
    // request; without it a DeepSeek answer arrives with no reasoning text.
    id: 'river',
    name: 'River AI',
    apiFormat: 'openai-chat-completions',
    baseURL: RIVER_BASE_URL,
    defaultModel: RIVER_DEFAULT_MODEL,
    models: RIVER_MODEL_CATALOG.map((id) => ({
      id,
      name: id,
      ...(id === RIVER_DEFAULT_MODEL ? { default: true } : {}),
    })),
    capabilities: { streaming: true, tools: true, reasoning: true, multimodal: false },
    docsUrl: RIVER_DOCS_URL,
  },
];

/** config.json path that holds a provider's API key. */
export function apiKeyPathFor(providerId) {
  return `providers.${providerId}.apiKey`;
}

/** config.json path that holds a provider's base URL override. */
export function baseUrlPathFor(providerId) {
  return `providers.${providerId}.baseURL`;
}

/** config.json path that holds a provider's selected model. */
export function modelPathFor(providerId) {
  return `providerModel.${providerId}`;
}

export const MAX_EXTRA_PROVIDERS = 20;
export const MAX_MODELS_PER_PROVIDER = 100;

/** Trim and validate a model id; returns null when it cannot be used. */
export function normalizeModelId(value) {
  if (typeof value !== 'string') return null;
  const model = value.trim();
  if (!model || model.length > MAX_MODEL_ID_LENGTH) return null;
  return MODEL_ID_PATTERN.test(model) ? model : null;
}

/** Trim and validate a provider id; returns null when it cannot be used. */
export function normalizeProviderId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase();
  if (!id || id.length > 64) return null;
  return PROVIDER_ID_PATTERN.test(id) ? id : null;
}

function normalizeModelEntries(raw, issues, label) {
  const entries = [];
  if (!Array.isArray(raw)) {
    issues.push(`${label} must be an array of model ids or { id, name } objects`);
    return entries;
  }
  for (const item of raw.slice(0, MAX_MODELS_PER_PROVIDER)) {
    const id = normalizeModelId(typeof item === 'string' ? item : item?.id);
    if (!id) {
      issues.push(`${label} contains an invalid model id: ${JSON.stringify(item?.id ?? item)}`);
      continue;
    }
    if (entries.some((entry) => entry.id === id)) continue;
    const name = typeof item?.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 120) : id;
    entries.push({ id, name });
  }
  return entries;
}

function normalizeCapabilities(raw, issues, label) {
  const defaults = { streaming: true, tools: true, reasoning: false, multimodal: false };
  if (raw === undefined || raw === null) return defaults;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push(`${label}.capabilities must be an object`);
    return defaults;
  }
  const out = { ...defaults };
  for (const key of ['streaming', 'tools', 'reasoning', 'multimodal']) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'boolean') {
      issues.push(`${label}.capabilities.${key} must be true or false`);
      continue;
    }
    out[key] = raw[key];
  }
  // Vendor extras kept inside capabilities (e.g. River's reasoning effort) are
  // copied through untouched: the client that knows the field validates it.
  if (typeof raw.reasoningEffort === 'string' && raw.reasoningEffort.trim()) {
    out.reasoningEffort = raw.reasoningEffort.trim();
  }
  return out;
}

/** Copy the per-provider request overrides the descriptor declares. */
function mergeRequestFields(entry, raw, label, issues) {
  for (const field of PROVIDER_REQUEST_FIELDS) {
    if (raw[field] === undefined) continue;
    if (field === 'reasoningEffort') {
      if (typeof raw[field] !== 'string' || !raw[field].trim()) {
        issues.push(`${label}.reasoningEffort must be a non-empty string`);
        continue;
      }
      entry[field] = raw[field].trim();
      continue;
    }
    if (field === 'thinking') {
      if (typeof raw[field] !== 'boolean') {
        issues.push(`${label}.thinking must be true or false`);
        continue;
      }
      entry[field] = raw[field];
      continue;
    }
    if (!raw[field] || typeof raw[field] !== 'object' || Array.isArray(raw[field])) {
      issues.push(`${label}.${field} must be a JSON object`);
      continue;
    }
    entry[field] = { ...raw[field] };
  }
}

/**
 * Parse the `extraProviders` list from config.json.
 *
 * Shape: `[{ "id": "myproxy", "name": "My Proxy", "baseURL": "https://…/v1",
 * "models": ["model-a", { "id": "b", "name": "B" }],
 * "defaultModel": "model-a", "capabilities": { "tools": false } }]`
 *
 * The key for an extra provider is stored like any other provider's:
 * `providers.myproxy.apiKey`. Invalid entries are reported as config issues
 * instead of being guessed.
 */
export function parseExtraProviders(value, issues = [], warnings = []) {
  if (value === undefined || value === null || String(value).trim() === '') return [];
  let parsed;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch (error) {
    issues.push(`extraProviders is not valid JSON: ${error.message}`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    issues.push('extraProviders must be a JSON array of provider objects');
    return [];
  }
  const builtinIds = new Set(BUILTIN_PROVIDERS.map((provider) => provider.id));
  const extras = [];
  for (const [index, raw] of parsed.slice(0, MAX_EXTRA_PROVIDERS).entries()) {
    const label = `extraProviders[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      issues.push(`${label} must be an object`);
      continue;
    }
    const id = normalizeProviderId(raw.id);
    if (!id) {
      issues.push(`${label}.id must match ${PROVIDER_ID_PATTERN}`);
      continue;
    }
    if (builtinIds.has(id)) {
      // A stale entry for a provider that has since become built-in (River,
      // for example) is dropped instead of failing startup, as long as it
      // points at the same endpoint; the built-in descriptor then supplies the
      // models, capabilities and any vendor request fields.
      const builtin = BUILTIN_PROVIDERS.find((provider) => provider.id === id);
      const sameUrl =
        builtin &&
        String(raw.baseURL || '').trim().replace(/\/+$/, '') === String(builtin.baseURL).trim().replace(/\/+$/, '');
      if (sameUrl) {
        warnings.push(
          `${label} redeclares the built-in provider "${id}" with the same base URL; the built-in provider is used and this entry is ignored.`,
        );
        continue;
      }
      issues.push(`${label}.id ${JSON.stringify(id)} is already registered`);
      continue;
    }
    if (extras.some((provider) => provider.id === id)) {
      issues.push(`${label}.id ${JSON.stringify(id)} is already registered`);
      continue;
    }
    const baseURL = typeof raw.baseURL === 'string' ? raw.baseURL.trim() : '';
    if (!baseURL) {
      issues.push(`${label}.baseURL is required`);
      continue;
    }
    // A provider added with `/provider add` starts with no models; `/addmodel`
    // fills the list, so a missing default is allowed until then.
    const models = raw.models === undefined ? [] : normalizeModelEntries(raw.models, issues, `${label}.models`);
    const defaultModel = normalizeModelId(raw.defaultModel) || models[0]?.id || null;
    if (defaultModel && !models.some((entry) => entry.id === defaultModel)) {
      models.unshift({ id: defaultModel, name: defaultModel });
    }
    extras.push({
      id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : id,
      apiFormat: 'openai-chat-completions',
      baseURL,
      defaultModel,
      models,
      capabilities: normalizeCapabilities(raw.capabilities, issues, label),
      docsUrl: null,
      source: 'settings',
      ...(() => {
        const entry = {};
        mergeRequestFields(entry, raw, label, issues);
        return entry;
      })(),
    });
  }
  if (parsed.length > MAX_EXTRA_PROVIDERS) {
    issues.push(`extraProviders lists more than ${MAX_EXTRA_PROVIDERS} providers; the rest were ignored`);
  }
  return extras;
}

/**
 * Build the effective provider descriptors: built-ins plus `extraProviders`,
 * with the API key, base URL and model stored in config.json merged in.
 *
 * `credentials` uses the settings shape: `{ nvidia: { apiKey, baseURL, model } }`.
 * Credentials stay on the descriptor so a later `/provider` switch needs no
 * extra lookup, and so the logger can redact every configured key at once.
 */
export function buildProviders({ credentials = {}, extras = [] } = {}) {
  const providers = [];
  for (const base of [...BUILTIN_PROVIDERS.map((provider) => ({ ...provider, models: [...provider.models] })), ...extras]) {
    const stored = credentials?.[base.id] && typeof credentials[base.id] === 'object' ? credentials[base.id] : {};
    const baseURL = String(stored.baseURL || base.baseURL).trim();
    const apiKey = String(stored.apiKey || '').trim();
    const model = normalizeModelId(stored.model) || base.defaultModel;
    const models = [...base.models];
    if (model && !models.some((entry) => entry.id === model)) models.push({ id: model, name: model });
    const descriptor = {
      ...base,
      baseURL,
      apiKey,
      apiKeyPath: apiKeyPathFor(base.id),
      baseUrlPath: baseUrlPathFor(base.id),
      modelPath: modelPathFor(base.id),
      defaultModel: model,
      models,
    };
    // Per-provider request overrides live next to the key
    // (`providers.<id>.reasoningEffort`, `providers.<id>.extraBody`, ...). They
    // travel with the descriptor, so `/provider` keeps them and the client
    // sends them only to that provider.
    for (const field of PROVIDER_REQUEST_FIELDS) {
      const value = stored[field];
      if (value === undefined) continue;
      if (field === 'reasoningEffort') {
        if (typeof value === 'string' && value.trim()) descriptor[field] = value.trim();
        continue;
      }
      if (field === 'thinking') {
        if (typeof value === 'boolean') descriptor[field] = value;
        continue;
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) descriptor[field] = { ...value };
    }
    providers.push(descriptor);
  }
  return providers;
}

/** Find one provider descriptor by id (case-insensitive). */
export function providerById(providers = [], id) {
  const wanted = normalizeProviderId(id);
  if (!wanted) return null;
  return providers.find((provider) => provider.id === wanted) || null;
}

/**
 * Which provider is active?
 *
 * Precedence: explicit selection (`--provider` / `provider` in config.json / a persisted
 * `/provider` choice) > NVIDIA when its key is present > the first provider
 * with a key > `nvidia` (so the resulting error names the expected variable).
 */
export function resolveProviderId({ explicit = null, providers = [] } = {}) {
  if (explicit) return normalizeProviderId(explicit) || String(explicit).trim().toLowerCase();
  const nvidia = providerById(providers, DEFAULT_PROVIDER_ID);
  if (nvidia?.apiKey) return nvidia.id;
  const configured = providers.find((provider) => provider.apiKey);
  return configured?.id || DEFAULT_PROVIDER_ID;
}

/** Catalog models for a provider, plus user-added ids, de-duplicated in order. */
export function modelsFor(provider, custom = []) {
  const entries = (provider?.models || []).map((entry) => ({ ...entry }));
  for (const id of custom) {
    if (!entries.some((entry) => entry.id === id)) entries.push({ id, name: id, added: true });
  }
  return entries;
}

/** True when the model id is in the provider's declared list. */
export function isCatalogModel(provider, model) {
  return Boolean(provider?.models?.some((entry) => entry.id === model));
}
