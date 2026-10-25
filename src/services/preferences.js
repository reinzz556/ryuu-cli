import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * User preferences that survive CLI restarts: the `/model` choice and the
 * model ids added with `/addmodel`.
 *
 * The state lives in the workspace's `.ryuu` folder next to sessions, logs,
 * undo and cache, so the choice follows the project the CLI is run from.
 * Values are validated before being read back, so a hand-edited or corrupt
 * file can never put an invalid model id into the config.
 */

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

/** Upper bound on user-added models, so the list cannot grow without limit. */
export const MAX_CUSTOM_MODELS = 100;
export const MAX_MODEL_ID_LENGTH = 200;

/**
 * Trim and validate a model id. Returns null when it cannot be persisted
 * (empty, non-string, too long, or containing characters a model id never
 * uses). Existence on the server is deliberately NOT checked.
 */
export function normalizeModelId(value) {
  if (typeof value !== 'string') return null;
  const model = value.trim();
  if (!model || model.length > MAX_MODEL_ID_LENGTH) return null;
  return MODEL_ID.test(model) ? model : null;
}

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

/** Read the persisted model, or null when absent/invalid. Never throws. */
export async function readModelPreference(dir) {
  return normalizeModelId((await readPreferences(dir)).model);
}

/** Persist the model choice. Returns false (no throw) for invalid ids. */
export async function writeModelPreference(dir, model) {
  const id = normalizeModelId(model);
  if (!id) return false;
  return writePreferences(dir, { model: id });
}

/**
 * The ids added with `/addmodel`, in insertion order, de-duplicated and
 * validated. A corrupt entry is skipped instead of failing the whole list.
 */
export async function readCustomModels(dir) {
  const raw = (await readPreferences(dir)).models;
  if (!Array.isArray(raw)) return [];
  const models = [];
  for (const entry of raw) {
    const model = normalizeModelId(entry);
    if (model && !models.includes(model)) models.push(model);
    if (models.length >= MAX_CUSTOM_MODELS) break;
  }
  return models;
}

/**
 * Add an id to the saved model list. Returns { ok, reason, models }; reason is
 * 'invalid' | 'exists' | 'limit' | 'write' when ok is false, null otherwise.
 */
export async function addCustomModel(dir, id) {
  const models = await readCustomModels(dir);
  const model = normalizeModelId(id);
  if (!model) return { ok: false, reason: 'invalid', models };
  if (models.includes(model)) return { ok: false, reason: 'exists', models };
  if (models.length >= MAX_CUSTOM_MODELS) return { ok: false, reason: 'limit', models };
  const next = [...models, model];
  const saved = await writePreferences(dir, { models: next });
  return saved ? { ok: true, reason: null, models: next } : { ok: false, reason: 'write', models };
}

/**
 * Remove an id from the saved model list. Returns { ok, reason, models };
 * reason is 'missing' | 'write' when ok is false, null otherwise.
 */
export async function removeCustomModel(dir, id) {
  const models = await readCustomModels(dir);
  const model = normalizeModelId(id);
  if (!model || !models.includes(model)) return { ok: false, reason: 'missing', models };
  const next = models.filter((entry) => entry !== model);
  const saved = await writePreferences(dir, { models: next });
  return saved ? { ok: true, reason: null, models: next } : { ok: false, reason: 'write', models };
}

/**
 * Apply the persisted `/model` choice at startup.
 * Precedence: explicit --model flag (this run only) > persisted choice >
 * NVIDIA_MODEL > default. Returns true when raw.model was changed.
 */
export async function applyPersistedModel(raw, { flagModel = null, stateDir = null } = {}) {
  if (flagModel || !stateDir) return false;
  const persisted = await readModelPreference(stateDir);
  if (!persisted || persisted === raw.model) return false;
  raw.model = persisted;
  return true;
}
