import { createGoogleDrivePlugin, googleDrivePluginDescriptor } from './google-drive/index.js';

/**
 * Plugin host for Ryuu CLI.
 *
 * Plugins live outside `src/` on purpose: they are optional integrations that
 * are wired into the existing tool registry and command parser instead of
 * becoming part of the core service layer. A plugin never registers its tools
 * directly — the host does, and only when the integration is enabled and
 * authenticated.
 */

const FACTORIES = [
  { descriptor: googleDrivePluginDescriptor, create: (options) => createGoogleDrivePlugin(options) },
];

/** Instantiate every known plugin. Failures are reported, not fatal. */
export function loadPlugins({ logger = null, workspace = null, config = null } = {}) {
  const plugins = [];
  for (const entry of FACTORIES) {
    try {
      plugins.push(entry.create({ logger, workspace, config }));
    } catch (error) {
      logger?.warn?.(`plugin ${entry.descriptor.name} failed to load`, { error: error.message });
    }
  }
  return plugins;
}

/**
 * Attach the plugin tools to a registry when its lifecycle state allows it.
 *
 * Returns the number of tools registered. Registration is idempotent per
 * process: a second call with the same state reuses the registry's plugin
 * bookkeeping instead of throwing a collision.
 */
export async function syncPluginTools(plugin, registry) {
  if (!plugin || !registry) return 0;
  const ready = (await plugin.isEnabled()) && (await plugin.isAuthenticated());
  if (!ready) return 0;
  if (registry.plugins?.has?.(plugin.name)) return plugin.tools.length;
  registry.registerPlugin({ name: plugin.name, version: plugin.version, tools: plugin.tools });
  return plugin.tools.length;
}

/** Remove one plugin's tools from the registry (used by /drive disable). */
export function unregisterPluginTools(plugin, registry) {
  if (!plugin || !registry?.plugins?.has?.(plugin.name)) return 0;
  const entry = registry.plugins.get(plugin.name);
  const names = entry?.toolNames || [];
  for (const name of names) registry.tools.delete(name);
  registry.plugins.delete(plugin.name);
  return names.length;
}

export { googleDrivePluginDescriptor };
