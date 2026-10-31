/**
 * Provider identifiers and model-id rules.
 *
 * These primitives are shared by the provider modules (`nvidia.js`,
 * `tokenharbor.js`, `river.js`) and by the catalog that assembles them. They
 * live in their own file so a provider module can be imported by the catalog
 * without an import cycle.
 */

/** ID used when nothing else selects a provider. */
export const DEFAULT_PROVIDER_ID = 'nvidia';

export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
export const MAX_MODEL_ID_LENGTH = 200;

/**
 * Per-provider request fields a config.json override may carry verbatim.
 *
 * `reasoningEffort` becomes the wire field `reasoning_effort`; `extraBody`
 * and `requestParams` are merged into the request body as-is; `thinking` is a
 * boolean shorthand for turning reasoning on or off.
 */
export const PROVIDER_REQUEST_FIELDS = ['reasoningEffort', 'extraBody', 'requestParams', 'thinking'];
