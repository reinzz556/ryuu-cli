/**
 * MCP client integration for Ryuu.
 *
 * Public entry points:
 *   - `McpManager`      lifecycle, registry sync, tool/resource/prompt access
 *   - `createMcpCommand` the `/mcp` command handler
 *   - config helpers     storage paths, server records and private credentials
 */

export { McpManager, publicRecord } from './manager.js';
export { createMcpCommand } from './command.js';
export { McpError } from './errors.js';
export { classifyToolRisk, normalizeCallResult, sanitizeInputSchema } from './convert.js';
export { buildToolName, displayToolName } from './naming.js';
export {
  MCP_DEFAULTS,
  credentialsDir,
  listServers,
  logFile,
  logsDir,
  mcpRoot,
  readSecrets,
  readStore,
  serversFile,
  splitServerInput,
} from './config.js';

import { McpManager } from './manager.js';

/** Construct the manager without leaking the module path to the CLI. */
export function createMcpManager(options = {}) {
  return new McpManager(options);
}
