/**
 * Tool naming for MCP.
 *
 * Provider function names (OpenAI/Anthropic style) accept only letters, digits,
 * `_` and `-`, so an MCP tool cannot be registered under its raw
 * `server:tool` identity. Every tool is therefore registered as
 * `mcp_<server>_<tool>` and displayed by the CLI as `mcp:<server>:<tool>`.
 *
 * The translation is deterministic and collision-safe: the first tool keeps the
 * short name, later collisions get `_2`, `_3`, … and an over-long name is
 * truncated with a stable hash suffix instead of silently shadowing another
 * tool.
 */

import crypto from 'node:crypto';

/** ToolRegistry's NAME_PATTERN allows 2–61 chars. */
export const MAX_REGISTERED_NAME = 61;
/** Plugin names allow 2–41 chars. */
const MAX_PLUGIN_NAME = 41;

function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

/** A short stable hash for a name that has to be truncated. */
function shortHash(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 6);
}

/** Server component of a registered tool name (`google-drive` → `google_drive`). */
export function serverSlug(server) {
  const slug = slugify(server);
  return slug.startsWith('_') ? `s${slug}` : slug || 'server';
}

/**
 * Registry plugin name for one MCP server: `mcp-<server>`.
 *
 * Keeping each server in the plugin registry means `/tools`, approval labels and
 * the renderer already know a tool's origin without a parallel lookup table.
 */
export function serverPluginName(server) {
  const base = `mcp-${String(server ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')}`;
  if (base.length <= MAX_PLUGIN_NAME) return base;
  return `${base.slice(0, MAX_PLUGIN_NAME - 7)}-${shortHash(server)}`;
}

/**
 * Registered function name for one MCP tool.
 *
 * @param {string} server MCP server name
 * @param {string} tool MCP tool name as announced by the server
 * @param {Set<string>} [taken] names already in use; the result avoids them
 */
export function buildToolName(server, tool, taken = new Set()) {
  const base = `mcp_${serverSlug(server)}_${slugify(tool) || 'tool'}`;
  const clipped = base.length > MAX_REGISTERED_NAME ? `${base.slice(0, MAX_REGISTERED_NAME - 7)}_${shortHash(base)}` : base;
  let candidate = clipped;
  let counter = 2;
  while (taken.has(candidate)) {
    const suffix = `_${counter}`;
    candidate = `${clipped.slice(0, MAX_REGISTERED_NAME - suffix.length)}${suffix}`;
    counter += 1;
  }
  return candidate;
}

/** Human/display identity, e.g. `mcp:google-drive:search_files`. */
export function displayToolName(server, tool) {
  return `mcp:${server}:${tool}`;
}

/** True when a display name came from this module. */
export function isMcpDisplayName(value) {
  return /^mcp:[^:]+:/.test(String(value ?? ''));
}
