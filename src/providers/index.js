import { ProviderError } from '../utils/errors.js';
import { ProviderRegistry } from './registry.js';
import { createProvider as createChatCompletionsProvider } from './nvidia.js';
import {
  DEFAULT_PROVIDER_ID,
  normalizeModelId,
  normalizeProviderId,
  providerById,
} from './catalog.js';

/**
 * Provider wiring.
 *
 * Every catalog entry speaks the OpenAI Chat Completions protocol, so they all
 * share one client implementation. The registry exists so a new protocol can be
 * added later without touching the agent: register a factory under its id and
 * the selection code will use it.
 */
function factory(config, deps) {
  return createChatCompletionsProvider(config, deps);
}

export const providerRegistry = new ProviderRegistry({
  nvidia: factory,
  tokenharbor: factory,
});

/**
 * Create the provider instance for an already validated config.
 *
 * `extraProviders` entries are registered on first use, which is why a provider
 * added in config.json needs no code change.
 */
export function createActiveProvider(config, deps = {}) {
  const id = normalizeProviderId(config.providerId) || DEFAULT_PROVIDER_ID;
  if (!providerRegistry.has(id)) providerRegistry.register(id, factory);
  return providerRegistry.resolve(id, config, deps);
}

/**
 * Resolve the descriptor for a provider/model selection.
 *
 * Validates the provider id, that its key is configured, and the model id
 * before anything is sent. A model that is not in the declared list is allowed
 * (it may be a newer model) but must still be a well-formed id.
 */
export function selectionFor(config, providerId, { model = null } = {}) {
  const descriptor = providerById(config.providers, providerId);
  if (!descriptor) {
    const known = (config.providers || []).map((provider) => provider.id).join(', ') || '(none)';
    throw new ProviderError(`Unknown provider: ${providerId}. Known providers: ${known}.`, {
      code: 'UNKNOWN_PROVIDER',
    });
  }
  if (!descriptor.apiKey) {
    throw new ProviderError(
      `Provider ${descriptor.id} has no API key. Add your key to config.json with \`ryuu --settings\` (${descriptor.apiKeyPath}) before switching.`,
      { code: 'AUTH_MISSING' },
    );
  }
  const requested = model === null || model === undefined || model === '' ? null : normalizeModelId(model);
  if (model !== null && model !== undefined && model !== '' && !requested) {
    throw new ProviderError(`Invalid model id: ${JSON.stringify(model)}`, { code: 'INVALID_MODEL' });
  }
  const chosen = requested || normalizeModelId(descriptor.defaultModel) || descriptor.models?.[0]?.id || null;
  if (!chosen) {
    throw new ProviderError(`Provider ${descriptor.id} has no usable model configured.`, { code: 'INVALID_MODEL' });
  }
  return {
    providerId: descriptor.id,
    providerName: descriptor.name,
    apiKeyPath: descriptor.apiKeyPath,
    docsUrl: descriptor.docsUrl || null,
    baseURL: descriptor.baseURL,
    apiKey: descriptor.apiKey,
    model: chosen,
    capabilities: { ...(descriptor.capabilities || {}) },
  };
}

export { providerById, normalizeModelId, normalizeProviderId };
