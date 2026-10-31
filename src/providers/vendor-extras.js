/**
 * Provider ids whose request body needs extra fields. Keyed by provider id (and
 * by API host for a hand-written entry pointing at the same endpoint).
 *
 * `passthrough` is the fallback for any provider without a registered builder:
 * a `extraBody`/`requestParams` object in its config.json entry is copied into
 * the request verbatim, so an unusual gateway stays reachable without a code
 * change.
 */

/** providerId -> { builder, hosts: Set<string> } */
const builders = new Map();

function hostOf(baseURL) {
  try {
    return new URL(String(baseURL || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Register (or replace) the builder for one provider id.
 *
 * `hosts` makes the builder apply to any provider whose base URL uses that host,
 * which keeps a hand-written `extraProviders` entry for the same vendor working.
 */
export function registerRequestExtras(providerId, builder, { hosts = [] } = {}) {
  if (!providerId || typeof builder !== 'function') return;
  const list = [].concat(hosts).map((host) => String(host || '').toLowerCase()).filter(Boolean);
  builders.set(String(providerId), { builder, hosts: new Set(list) });
}

/** Remove a builder. Mostly useful for tests. */
export function unregisterRequestExtras(providerId) {
  builders.delete(String(providerId));
}

/** The registered builder for a provider id, then fall back to its API host. */
export function requestExtrasFor(providerId, baseURL = '') {
  const direct = builders.get(String(providerId || ''));
  if (direct) return direct.builder;
  const host = hostOf(baseURL);
  if (!host) return null;
  for (const entry of builders.values()) {
    if (entry.hosts.has(host)) return entry.builder;
  }
  return null;
}

/**
 * Default builder for providers without one: copy the explicit pass-through
 * objects a config.json entry may carry. Nothing is guessed, so a plain provider
 * still sends only the standard Chat Completions fields.
 */
export function passthroughExtras(config = {}) {
  const extras = {};
  for (const field of ['extraBody', 'requestParams']) {
    const value = config?.[field];
    if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(extras, value);
  }
  return extras;
}

/**
 * Extra top-level request fields for this provider, or null when it has none.
 * A builder that throws must never break a request: the failure is swallowed
 * and the request goes out unchanged.
 */
export function applyRequestExtras(config, context = {}) {
  const builder = requestExtrasFor(config?.providerId, config?.baseURL) || passthroughExtras;
  try {
    const extras = builder(config, context);
    return extras && typeof extras === 'object' && Object.keys(extras).length > 0 ? extras : null;
  } catch (error) {
    context.logger?.warn('provider request extras failed; sending the request unchanged', {
      provider: config?.providerId,
      message: error?.message || String(error),
    });
    return null;
  }
}