import { ProviderError } from '../utils/errors.js';

/**
 * Multi-provider registry.
 *
 * Providers are registered by ID and can be instantiated on demand with a
 * config object. The registry keeps a cache of created providers so the same
 * instance is reused across requests within a session.
 *
 * Usage:
 *   const registry = new ProviderRegistry();
 *   registry.register('tokenharbor', createTokenHarborProvider);
 *   const provider = await registry.resolve('tokenharbor', config, { logger });
 *
 * Provider factories receive (config, deps) and must return an object with at
 * least `chat(...)`, `ping()`, and a `model` getter (matching the existing
 * NvidiaProvider interface).
 */
export class ProviderRegistry {
  constructor(factories = {}) {
    this.factories = new Map();
    this.providers = new Map();
    for (const [id, factory] of Object.entries(factories)) {
      this.factories.set(id, factory);
    }
  }

  /** Register a provider factory under an id. Overwrites any existing one. */
  register(id, factory) {
    if (!id || typeof id !== 'string') {
      throw new ProviderError('Provider id must be a non-empty string.', {
        code: 'INVALID_PROVIDER_ID',
      });
    }
    if (typeof factory !== 'function') {
      throw new ProviderError(`Provider factory for ${id} must be a function.`, {
        code: 'INVALID_PROVIDER_FACTORY',
      });
    }
    this.factories.set(id, factory);
    this.providers.delete(id); // drop any cached instance for the old factory
  }

  /** Unregister a provider and drop any cached instance. */
  unregister(id) {
    this.factories.delete(id);
    this.providers.delete(id);
  }

  /** Check whether a provider id is known (registered or already instantiated). */
  has(id) {
    return this.factories.has(id) || this.providers.has(id);
  }

  /** List all known provider ids. */
  list() {
    return [...this.factories.keys()];
  }

  /** Return a cached provider instance, or null when none exists yet. */
  get(id) {
    return this.providers.get(id) || null;
  }

  /** Create (and cache) a provider instance for the given id. */
  create(id, config, deps = {}) {
    const factory = this.factories.get(id);
    if (!factory) {
      throw new ProviderError(`Unknown provider: ${id}. Registered: ${this.list().join(', ') || '(none)'}`, {
        code: 'UNKNOWN_PROVIDER',
      });
    }
    const provider = factory(config, deps);
    this.providers.set(id, provider);
    return provider;
  }

  /** Resolve a provider: return the cached instance or create a new one. */
  resolve(id, config, deps = {}) {
    if (!this.has(id)) {
      throw new ProviderError(`Unknown provider: ${id}. Registered: ${this.list().join(', ') || '(none)'}`, {
        code: 'UNKNOWN_PROVIDER',
      });
    }
    const existing = this.providers.get(id);
    if (existing) return existing;
    return this.create(id, config, deps);
  }

  /** Create providers for every registered id (e.g. for health checks). */
  async createAll(config, deps = {}) {
    const instances = new Map();
    for (const id of this.list()) {
      try {
        instances.set(id, this.create(id, config, deps));
      } catch {
        // Providers that fail to instantiate are simply skipped.
      }
    }
    return instances;
  }
}

export const defaultRegistry = new ProviderRegistry();
