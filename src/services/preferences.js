import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_PROVIDER_ID,
  MODEL_ID_PATTERN,
  MAX_MODEL_ID_LENGTH,
  normalizeModelId,
  normalizeProviderId,
} from '../providers/catalog.js';

/**
 * User preferences that survive CLI restarts: the active provider, the active
 * model, and the model ids added with `/addmodel`.
 *
 * The state lives in the workspace's `.ryuu` folder next to sessions, logs,
 * undo and cache, so the choice follows the project the CLI is run from.
 * Values are validated before being read back, so a hand-edited or corrupt
 * file can never put an invalid provider/model id into the config.
 *
 * Shape (all keys optional):
 *   {
 *     "provider": "tokenharbor",
 *     "model": "deepseek-v4.1-flash:free",
 *     "providerModel": { "nvidia": "…", "tokenharbor": "…" },
 *     "providerModels": { "nvidia": ["added-id"] },
 *     "models": ["legacy ids, read as the active provider's list"]
 *   }
 */

/** Upper bound on user-added models, so the list cannot grow without limit. */
export const MAX_CUSTOM_MODELS = 100;
export { MAX_MODEL_ID_LENGTH, MODEL_ID_PATTERN, normalizeModelId };

/** Root of the local state folder for a workspace. */
export function stateDirFor(workspace) {
  return path.join(workspace || '.', '.ryuu');
}

export function preferencesFile(dir) {
  return path.join(dir, 'preferences.json');
}

/** Read the whole preferences object; {} when absent or corrupt. Never throws. */
export async function readPreferences(dir) {
  try {
    const data = JSON.parse(await fsp.readFile(preferencesFile(dir), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/**
 * Merge a patch into preferences.json. Other keys are preserved, so adding or
 * removing a model never forgets the selected model, and switching a model
 * never forgets the added ones.
 */
async function writePreferences(dir, patch) {
  try {
    const payload = {
      ...(await readPreferences(dir)),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(preferencesFile(dir), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function normalizeModelList(raw) {
  if (!Array.isArray(raw)) return [];
  const models = [];
  for (const entry of raw) {
    const model = normalizeModelId(entry);
    if (model && !models.includes(model)) models.push(model);
    if (models.length >= MAX_CUSTOM_MODELS) break;
  }
  return models;
}

/** A validated `provider -> [model ids]` map (unknown entries skipped). */
function modelListMap(raw) {
  const map = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return map;
  for (const [id, list] of Object.entries(raw)) {
    const providerId = normalizeProviderId(id);
    if (providerId) map[providerId] = normalizeModelList(list);
  }
  return map;
}

/** A validated `provider -> model id` map. */
function modelChoiceMap(raw) {
  const map = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return map;
  for (const [id, model] of Object.entries(raw)) {
    const providerId = normalizeProviderId(id);
    const normalized = normalizeModelId(model);
    if (providerId && normalized) map[providerId] = normalized;
  }
  return map;
}

/** Read the persisted model, or null when absent/invalid. Never throws. */
export async function readModelPreference(dir) {
  return normalizeModelId((await readPreferences(dir)).model);
}

/**
 * Persist the model choice. With a provider id the choice is also recorded for
 * that provider, so switching providers remembers each one's last model.
 * Returns false (no throw) for invalid ids.
 */
export async function writeModelPreference(dir, model, { providerId = null } = {}) {
  const id = normalizeModelId(model);
  if (!id) return false;
  const provider = normalizeProviderId(providerId);
  if (!provider) return writePreferences(dir, { model: id });
  const prefs = await readPreferences(dir);
  return writePreferences(dir, {
    model: id,
    providerModel: { ...modelChoiceMap(prefs.providerModel), [provider]: id },
  });
}

/** Last model chosen for a provider (falls back to the legacy top-level value). */
export async function readProviderModel(dir, providerId) {
  const provider = normalizeProviderId(providerId);
  if (!provider) return null;
  const prefs = await readPreferences(dir);
  const choices = modelChoiceMap(prefs.providerModel);
  if (choices[provider]) return choices[provider];
  const hasChoices = Object.keys(choices).length > 0;
  // Backwards compatibility: files written before per-provider models existed
  // stored one top-level `model` for the then-active provider.
  if (!hasChoices) {
    const active = normalizeProviderId(prefs.provider) || DEFAULT_PROVIDER_ID;
    if (provider === active) return normalizeModelId(prefs.model);
  }
  return null;
}

/** Persist a model choice for one provider without changing the active model. */
export async function writeProviderModel(dir, providerId, model) {
  const provider = normalizeProviderId(providerId);
  const id = normalizeModelId(model);
  if (!provider || !id) return false;
  const prefs = await readPreferences(dir);
  return writePreferences(dir, {
    providerModel: { ...modelChoiceMap(prefs.providerModel), [provider]: id },
  });
}

/** Read the persisted provider id, or null when absent/invalid. Never throws. */
export async function readProviderPreference(dir) {
  return normalizeProviderId((await readPreferences(dir)).provider);
}

/** Persist the active provider id. Returns false (no throw) for invalid ids. */
export async function writeProviderPreference(dir, providerId) {
  const id = normalizeProviderId(providerId);
  if (!id) return false;
  return writePreferences(dir, { provider: id });
}

/**
 * The ids added with `/addmodel` for one provider, in insertion order,
 * de-duplicated and validated. A corrupt entry is skipped instead of failing
 * the whole list. Without a provider id the legacy shared list is returned.
 */
export async function readCustomModels(dir, providerId = null) {
  const prefs = await readPreferences(dir);
  const legacy = normalizeModelList(prefs.models);
  const provider = normalizeProviderId(providerId);
  if (!provider) return legacy;
  const map = modelListMap(prefs.providerModels);
  if (Array.isArray(map[provider])) return map[provider];
  const active = normalizeProviderId(prefs.provider) || DEFAULT_PROVIDER_ID;
  return provider === active ? legacy : [];
}

async function writeCustomModels(dir, providerId, models) {
  const provider = normalizeProviderId(providerId);
  if (!provider) return writePreferences(dir, { models });
  const prefs = await readPreferences(dir);
  return writePreferences(dir, {
    providerModels: { ...modelListMap(prefs.providerModels), [provider]: models },
  });
}

/**
 * Add an id to a provider's saved model list. Returns { ok, reason, models };
 * reason is 'invalid' | 'exists' | 'limit' | 'write' when ok is false.
 */
export async function addCustomModel(dir, id, providerId = null) {
  const models = await readCustomModels(dir, providerId);
  const model = normalizeModelId(id);
  if (!model) return { ok: false, reason: 'invalid', models };
  if (models.includes(model)) return { ok: false, reason: 'exists', models };
  if (models.length >= MAX_CUSTOM_MODELS) return { ok: false, reason: 'limit', models };
  const next = [...models, model];
  const saved = await writeCustomModels(dir, providerId, next);
  return saved ? { ok: true, reason: null, models: next } : { ok: false, reason: 'write', models };
}

/**
 * Remove an id from a provider's saved model list. Returns { ok, reason,
 * models }; reason is 'missing' | 'write' when ok is false.
 */
export async function removeCustomModel(dir, id, providerId = null) {
  const models = await readCustomModels(dir, providerId);
  const model = normalizeModelId(id);
  if (!model || !models.includes(model)) return { ok: false, reason: 'missing', models };
  const next = models.filter((entry) => entry !== model);
  const saved = await writeCustomModels(dir, providerId, next);
  return saved ? { ok: true, reason: null, models: next } : { ok: false, reason: 'write', models };
}

/**
 * Apply the persisted `/provider` choice at startup. An explicit flag or a
 * `provider` key in config.json wins and is never overwritten. Returns true when raw.provider
 * was changed.
 */
export async function applyPersistedProvider(raw, { flagProvider = null, stateDir = null } = {}) {
  if (flagProvider || raw.provider || !stateDir) return false;
  const persisted = await readProviderPreference(stateDir);
  if (!persisted) return false;
  raw.provider = persisted;
  return true;
}

/**
 * Apply the persisted model at startup.
 * Precedence: explicit --model flag (this run only) > persisted choice for the
 * selected provider > the provider's own model variable > catalog default.
 * Returns true when raw.model was changed.
 */
export async function applyPersistedModel(raw, { flagModel = null, stateDir = null, providerId = null } = {}) {
  if (flagModel || !stateDir) return false;
  const persisted = providerId
    ? await readProviderModel(stateDir, providerId)
    : await readModelPreference(stateDir);
  if (!persisted || persisted === raw.model) return false;
  raw.model = persisted;
  return true;
}
