import { getSetting, updateSettings } from '../config/settings.js';
import {
  BUILTIN_PROVIDERS,
  MAX_EXTRA_PROVIDERS,
  MAX_MODELS_PER_PROVIDER,
  normalizeModelId,
  normalizeProviderId,
} from '../providers/catalog.js';

/**
 * Provider and model management for config.json.
 *
 * `/provider add|del` and `/addmodel|/delmodel` edit the same `extraProviders`
 * list the file already uses, so a provider added at runtime is indistinguishable
 * from one written by hand and survives restarts. Built-in providers are
 * read-only: only their added model ids (in .ryuu/preferences.json) are editable.
 */

const BUILTIN_IDS = new Set(BUILTIN_PROVIDERS.map((provider) => provider.id));

export function isBuiltinProviderId(id) {
  return BUILTIN_IDS.has(String(id ?? '').trim().toLowerCase());
}

/** The stored extraProviders array, never the module-level default. */
export function readExtraProviders(settings) {
  const value = getSetting(settings, 'extraProviders');
  return Array.isArray(value) ? value : [];
}

function modelIdsOf(entry) {
  if (!Array.isArray(entry?.models)) return [];
  return entry.models
    .map((model) => normalizeModelId(typeof model === 'string' ? model : model?.id))
    .filter(Boolean);
}

function normalizeBaseUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  try {
    const parsed = new URL(text);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

/**
 * Add a user provider. The id comes from the name, so `/provider add river …`
 * creates `river` and stores its key under `providers.river.apiKey`.
 * Returns { ok, reason } with reason 'builtin' | 'exists' | 'invalid' |
 * 'url' | 'limit' | 'write'.
 */
export async function addExtraProvider({ name, baseURL, apiKey = '', label = null }) {
  const id = normalizeProviderId(name);
  if (!id) return { ok: false, reason: 'invalid' };
  if (BUILTIN_IDS.has(id)) return { ok: false, reason: 'builtin' };
  const url = normalizeBaseUrl(baseURL);
  if (!url) return { ok: false, reason: 'url' };
  let reason = null;
  let updated = false;
  try {
    await updateSettings((draft) => {
      const entries = readExtraProviders(draft).filter((entry) => entry && typeof entry === 'object');
      const existing = entries.find((entry) => normalizeProviderId(entry.id) === id);
      if (existing) {
        // Re-adding with a key is the documented way to update it.
        if (!apiKey) {
          reason = 'exists';
          return draft;
        }
        draft.providers = draft.providers && typeof draft.providers === 'object' ? draft.providers : {};
        const stored = draft.providers[id] && typeof draft.providers[id] === 'object' ? draft.providers[id] : {};
        draft.providers[id] = { ...stored, apiKey: String(apiKey).trim() };
        updated = true;
        return draft;
      }
      if (entries.length >= MAX_EXTRA_PROVIDERS) {
        reason = 'limit';
        return draft;
      }
      entries.push({
        id,
        name: label || name,
        baseURL: url,
        models: [],
        capabilities: { streaming: true, tools: true, reasoning: false, multimodal: false },
      });
      draft.extraProviders = entries;
      if (apiKey) {
        draft.providers = draft.providers && typeof draft.providers === 'object' ? draft.providers : {};
        const stored = draft.providers[id] && typeof draft.providers[id] === 'object' ? draft.providers[id] : {};
        draft.providers[id] = { ...stored, apiKey: String(apiKey).trim() };
      } else if (draft.providers && typeof draft.providers === 'object' && !draft.providers[id]) {
        draft.providers[id] = { apiKey: '' };
      }
      return draft;
    });
  } catch {
    return { ok: false, reason: 'write' };
  }
  return reason ? { ok: false, reason } : { ok: true, reason: null, id, baseURL: url, updated };
}

/**
 * Remove a user provider plus its credentials and remembered model.
 * Returns { ok, reason } with reason 'builtin' | 'missing' | 'active' | 'write'.
 */
export async function removeExtraProvider(id, { active = false } = {}) {
  const provider = normalizeProviderId(id);
  if (!provider) return { ok: false, reason: 'missing' };
  if (BUILTIN_IDS.has(provider)) return { ok: false, reason: 'builtin' };
  if (active) return { ok: false, reason: 'active' };
  let reason = null;
  try {
    await updateSettings((draft) => {
      const entries = readExtraProviders(draft);
      const index = entries.findIndex((entry) => normalizeProviderId(entry?.id) === provider);
      if (index === -1) {
        reason = 'missing';
        return draft;
      }
      entries.splice(index, 1);
      draft.extraProviders = entries;
      if (draft.providers && typeof draft.providers === 'object') delete draft.providers[provider];
      if (draft.providerModel && typeof draft.providerModel === 'object') delete draft.providerModel[provider];
      return draft;
    });
  } catch {
    return { ok: false, reason: 'write' };
  }
  return reason ? { ok: false, reason } : { ok: true, reason: null };
}

/**
 * Append a model id to a user provider's `models`. The first model also becomes
 * the provider's default. Returns { ok, reason, added, models } with reason
 * 'missing' | 'builtin' | 'invalid' | 'exists' | 'limit' | 'write'.
 */
export async function addExtraProviderModel(id, model, { label = null } = {}) {
  const provider = normalizeProviderId(id);
  const modelId = normalizeModelId(model);
  if (!provider) return { ok: false, reason: 'missing' };
  if (!modelId) return { ok: false, reason: 'invalid' };
  if (BUILTIN_IDS.has(provider)) return { ok: false, reason: 'builtin' };
  let reason = null;
  let models = [];
  try {
    await updateSettings((draft) => {
      const entries = readExtraProviders(draft);
      const entry = entries.find((item) => normalizeProviderId(item?.id) === provider);
      if (!entry) {
        reason = 'missing';
        return draft;
      }
      models = modelIdsOf(entry);
      if (models.includes(modelId)) {
        reason = 'exists';
        return draft;
      }
      if (models.length >= MAX_MODELS_PER_PROVIDER) {
        reason = 'limit';
        return draft;
      }
      models.push(modelId);
      const storedNames = Array.isArray(entry.models)
        ? new Map(entry.models.map((item) => [normalizeModelId(typeof item === 'string' ? item : item?.id), typeof item === 'object' ? item?.name : null]))
        : new Map();
      entry.models = models.map((item) => {
        const display = storedNames.get(item);
        return display && display !== item ? { id: item, name: display } : item;
      });
      if (!normalizeModelId(entry.defaultModel)) entry.defaultModel = modelId;
      entry.name = entry.name || label || provider;
      return draft;
    });
  } catch {
    return { ok: false, reason: 'write' };
  }
  return reason ? { ok: false, reason, models } : { ok: true, reason: null, added: modelId, models };
}

/**
 * Remove a model id from a user provider and recompute its default.
 * Returns { ok, reason, models, defaultModel } with reason 'missing' | 'builtin'
 * | 'invalid' | 'absent' | 'write'.
 */
export async function removeExtraProviderModel(id, model) {
  const provider = normalizeProviderId(id);
  const modelId = normalizeModelId(model);
  if (!provider) return { ok: false, reason: 'missing' };
  if (!modelId) return { ok: false, reason: 'invalid' };
  if (BUILTIN_IDS.has(provider)) return { ok: false, reason: 'builtin' };
  let reason = null;
  let models = [];
  let defaultModel = null;
  try {
    await updateSettings((draft) => {
      const entries = readExtraProviders(draft);
      const entry = entries.find((item) => normalizeProviderId(item?.id) === provider);
      if (!entry) {
        reason = 'missing';
        return draft;
      }
      const current = modelIdsOf(entry);
      if (!current.includes(modelId)) {
        reason = 'absent';
        models = current;
        return draft;
      }
      models = current.filter((item) => item !== modelId);
      entry.models = models;
      if (normalizeModelId(entry.defaultModel) === modelId) entry.defaultModel = models[0] || null;
      defaultModel = normalizeModelId(entry.defaultModel);
      return draft;
    });
  } catch {
    return { ok: false, reason: 'write' };
  }
  return reason
    ? { ok: false, reason, models }
    : { ok: true, reason: null, models, defaultModel };
}
