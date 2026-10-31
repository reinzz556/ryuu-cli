import { MODEL_ID_PATTERN, MAX_MODEL_ID_LENGTH } from './catalog.js';
import { RIVER_DEFAULT_REASONING_EFFORT, RIVER_PROVIDER_ID, RIVER_REASONING_EFFORTS } from './catalog.js';
import { registerRequestExtras, passthroughExtras } from './vendor-extras.js';

export {
  RIVER_BASE_URL,
  RIVER_DEFAULT_MODEL,
  RIVER_DEFAULT_REASONING_EFFORT,
  RIVER_DOCS_URL,
  RIVER_MODEL_CATALOG,
  RIVER_PROVIDER_ID,
  RIVER_REASONING_EFFORTS,
} from './catalog.js';

/**
 * River AI provider.
 *
 * River speaks the OpenAI Chat Completions protocol, so it reuses the shared
 * client (`nvidia.js`) and only adds the vendor fields that protocol does not
 * define. The client asks `vendor-extras.js` for those fields by provider id,
 * and this module registers the River builder at import time — no subclass, so
 * one client instance keeps working across `/provider` switches.
 *
 * Why this file exists: River keeps thinking *off by default* for its DeepSeek
 * models, so a plain Chat Completions request never produces `reasoning_content`
 * and the CLI has nothing to render. River turns thinking on with a top-level
 * `reasoning_effort` field (see https://docs.river.ai/guides/inference-controls/),
 * which the shared client never sent. `riverRequestExtras()` adds it.
 *
 * The effort is only sent when the model is documented to accept it, and it is
 * only forced for models whose documented default is *off*; every other River
 * model already returns `reasoning_content` by itself.
 */

/**
 * Per-model reasoning profile, transcribed from
 * https://docs.river.ai/guides/inference-controls/ (read 2026-10-30).
 *
 * `levels` is the model's accepted `reasoning_effort` menu, `onByDefault` tells
 * whether it already thinks without the field, and `enable` is the level used to
 * turn thinking on. A model missing from this table is left untouched: an effort
 * value an endpoint does not know can fail the whole request.
 */
export const RIVER_MODEL_REASONING = {
  'deepseek-ai/DeepSeek-V4.1-Flash-1017': {
    levels: ['none', 'low', 'high', 'max'],
    onByDefault: false,
    enable: 'high',
  },
  'deepseek-ai/DeepSeek-V4.1-Flash': {
    levels: ['none', 'low', 'high', 'max'],
    onByDefault: false,
    enable: 'high',
  },
  'zai-org/GLM-5.3-Flash': { levels: ['low', 'high', 'max'], onByDefault: true, enable: 'max' },
  'GLM-5.3': { levels: ['low', 'high', 'max'], onByDefault: true, enable: 'max' },
  'Qwen/Qwen3.8-27B-FP8': { levels: ['none', 'low', 'medium', 'xhigh'], onByDefault: true, enable: 'xhigh' },
  'nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4': {
    levels: ['none', 'medium', 'high'],
    onByDefault: true,
    enable: 'high',
  },
};

/** Environment override for the River reasoning effort. */
export const RIVER_EFFORT_ENV = 'RYUU_RIVER_REASONING_EFFORT';
/** Generic environment override, read after the River-specific one. */
export const REASONING_EFFORT_ENV = 'RYUU_REASONING_EFFORT';

/**
 * Normalize an effort value.
 *
 * Returns one of the documented levels, or null when the value is not a level at
 * all. "off"/"disabled"/false map to "none" so the same word works in the
 * environment variable and in config.json.
 */
export function normalizeReasoningEffort(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? RIVER_DEFAULT_REASONING_EFFORT : 'none';
  const text = String(value).trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!text) return null;
  if (['off', 'false', 'no', 'disabled', 'disable'].includes(text)) return 'none';
  if (['on', 'true', 'yes', 'enabled'].includes(text)) return RIVER_DEFAULT_REASONING_EFFORT;
  return RIVER_REASONING_EFFORTS.includes(text) ? text : null;
}

/**
 * The effort the user asked for, or null when they asked for nothing.
 *
 * Precedence: `RYUU_RIVER_REASONING_EFFORT`, `reasoningEffort` from config.json,
 * `RYUU_REASONING_EFFORT`, then `capabilities.reasoningEffort` — so an official
 * `river` provider and a hand-written provider entry can both set it.
 */
export function resolveRequestedEffort(config = {}, env = process.env) {
  const candidates = [
    env?.[RIVER_EFFORT_ENV],
    config?.reasoningEffort,
    env?.[REASONING_EFFORT_ENV],
    config?.capabilities?.reasoningEffort,
  ];
  for (const candidate of candidates) {
    const effort = normalizeReasoningEffort(candidate);
    if (effort) return effort;
  }
  return null;
}

/** The model's documented profile, or null when it is not a known model. */
export function reasoningProfileFor(model) {
  return RIVER_MODEL_REASONING[String(model || '')] || null;
}

/**
 * Decide which `reasoning_effort` (if any) to send for a model.
 *
 * Returns null when the field must be omitted — the user asked for nothing and
 * the model already reasons by default, or the requested level is not in the
 * model's documented menu.
 */
export function resolveReasoningEffort(config = {}, { env = process.env, model = null, logger = null } = {}) {
  const target = String(model || config?.model || '');
  const profile = reasoningProfileFor(target);
  const requested = resolveRequestedEffort(config, env);
  let effort = null;
  if (requested) {
    effort = requested;
  } else if (config?.thinking === false) {
    effort = 'none';
  } else if (config?.thinking === true) {
    effort = profile?.enable || RIVER_DEFAULT_REASONING_EFFORT;
  } else if (profile && !profile.onByDefault) {
    effort = profile.enable; // DeepSeek: thinking is off unless asked for
  }
  if (!effort || effort === 'none') {
    // "none" only means something to a model that accepts it; elsewhere an
    // absent field falls back to the same model default.
    return effort === 'none' && profile?.levels?.includes('none') ? 'none' : null;
  }
  if (profile && !profile.levels.includes(effort)) {
    logger?.warn('reasoning_effort is not supported by this model; using the provider default', {
      model: target,
      requested: effort,
      supported: profile.levels,
    });
    return profile.enable && profile.levels.includes(profile.enable) ? profile.enable : null;
  }
  return effort;
}

/**
 * River's request-body extension for the shared client.
 *
 * Opaque pass-through fields first (a hand-written `extraProviders` entry may
 * carry `extraBody`/`requestParams`), then the `reasoning_effort` that turns
 * DeepSeek thinking on.
 */
export function riverRequestExtras(config = {}, { logger = null, env = process.env } = {}) {
  const extras = passthroughExtras(config);
  const effort = resolveReasoningEffort(config, { model: config.model, logger, env });
  if (effort) extras.reasoning_effort = effort;
  return extras;
}

/** True when a requestExtras() payload carries an explicit reasoning effort. */
export function hasReasoningEffort(extras) {
  const value = extras?.reasoning_effort;
  if (value === undefined || value === null) return false;
  return !(typeof value === 'string' && !value.trim());
}

/** Human-readable effort for /status. */
export function describeEffort(effort) {
  return !effort || effort === 'none' ? 'off (model default)' : effort;
}

/**
 * One line describing the reasoning effort that will be sent, or null when the
 * provider does not use one (so `/status` stays quiet for them).
 */
export function describeReasoning(config = {}, { env = process.env, logger = null } = {}) {
  const extras = riverRequestExtras(config, { env, logger });
  if (!hasReasoningEffort(extras)) return null;
  const effort = extras.reasoning_effort;
  return effort === 'none'
    ? 'off (reasoning_effort: none)'
    : `reasoning_effort: ${effort}`;
}

/** Sanity check used by tests and `/doctor`: the model id must remain valid. */
export function isValidRiverModel(model) {
  return typeof model === 'string' && model.length <= MAX_MODEL_ID_LENGTH && MODEL_ID_PATTERN.test(model);
}

// The shared client consults this table on every request. Registering at import
// time keeps the wiring in one place: `providers/index.js` only has to import
// this module, and any provider with the id "river" gets the extension. The host
// fallback also covers a hand-written `extraProviders` entry for the same API.
registerRequestExtras(RIVER_PROVIDER_ID, riverRequestExtras, { hosts: ['api.river.ai'] });