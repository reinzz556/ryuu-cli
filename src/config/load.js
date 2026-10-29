import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../utils/errors.js';

// The provider/model catalog lives with the providers; re-exported here so the
// existing import sites (and the documented env defaults) keep one location.
export { DEFAULT_BASE_URL, DEFAULT_MODEL, MODEL_CATALOG } from '../providers/catalog.js';

/** `.env` shipped next to the installed CLI (fallback for global runs). */
export const PACKAGE_ENV_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '.env',
);

/**
 * Load a .env file into process.env without overriding already-set variables.
 * Uses Node's built-in parser (Node >= 20.12) so there is no dotenv dependency.
 *
 * @returns {{loaded: string[], warnings: string[]}}
 */
export function loadEnvFile({ cwd = process.cwd(), envFile, fallbackFile = null, env = process.env } = {}) {
  const candidates = envFile ? [path.resolve(cwd, envFile)] : [path.join(cwd, '.env')];
  if (!envFile && fallbackFile) {
    const resolved = path.resolve(fallbackFile);
    if (!candidates.includes(resolved)) candidates.push(resolved);
  }
  const loaded = [];
  const warnings = [];

  for (const [index, file] of candidates.entries()) {
    if (!fs.existsSync(file)) {
      if (envFile) warnings.push(`Env file not found: ${file}`);
      continue;
    }
    const isFallback = !envFile && index > 0;
    const before = new Set(Object.keys(env));
    try {
      process.loadEnvFile(file);
      // process.loadEnvFile does not override existing vars; record anyway.
      const added = Object.keys(process.env).filter((key) => !before.has(key));
      loaded.push(file);
      if (added.length === 0 && !isFallback) {
        warnings.push(`Env file loaded but added no new variables (existing env wins): ${file}`);
      }
    } catch (error) {
      throw new ConfigError(`Failed to load env file ${file}: ${error.message}`, { file });
    }
  }
  return { loaded, warnings };
}

const intOrRaw = (value) => (value === undefined ? undefined : value);

/** Build a raw, unvalidated config object from an environment map. */
export function buildRawConfig(env = process.env, { cwd = process.cwd() } = {}) {
  return {
    // RYUU_* are provider-agnostic overrides. A provider's own key/model/base
    // URL (NVIDIA_*, TOKENHARBOR_*, …) is resolved by the provider catalog.
    apiKey: env.RYUU_API_KEY,
    model: env.RYUU_MODEL,
    baseURL: env.RYUU_BASE_URL,
    provider: env.RYUU_PROVIDER,
    extraProviders: env.RYUU_PROVIDERS,
    // A copy: persisted settings are injected here, and process.env must never
    // be mutated by the settings layer.
    providerEnv: { ...env },
    workspace: env.AGENT_WORKSPACE || '.',
    logLevel: env.LOG_LEVEL || 'info',
    maxSteps: intOrRaw(env.AGENT_MAX_STEPS),
    approvalPolicy: env.AGENT_APPROVAL_POLICY || 'ask',
    maxOutputTokens: intOrRaw(env.AGENT_MAX_OUTPUT_TOKENS),
    requestTimeoutMs: intOrRaw(env.AGENT_REQUEST_TIMEOUT_MS),
    streamIdleTimeoutMs: intOrRaw(env.AGENT_STREAM_IDLE_TIMEOUT_MS),
    maxRetries: intOrRaw(env.AGENT_MAX_RETRIES),
    maxRecoveryAttempts: intOrRaw(env.AGENT_MAX_RECOVERY_ATTEMPTS),
    recoveryBackoffMs: intOrRaw(env.AGENT_RECOVERY_BACKOFF_MS),
    maxFileBytes: intOrRaw(env.AGENT_MAX_FILE_BYTES),
    maxSearchResults: intOrRaw(env.AGENT_MAX_SEARCH_RESULTS),
    maxToolOutputBytes: intOrRaw(env.AGENT_MAX_TOOL_OUTPUT_BYTES),
    maxTaskDurationMs: intOrRaw(env.AGENT_MAX_TASK_DURATION_MS),
    maxContextChars: intOrRaw(env.AGENT_MAX_CONTEXT_CHARS),
    // Web search is optional: without a key the tool is not registered at all.
    webSearchApiKey: env.SEARCH_API_KEY || env.WEB_SEARCH_API_KEY || env.SERPER_API_KEY,
    webSearchEndpoint: env.WEB_SEARCH_ENDPOINT,
    webSearchAuthHeader: env.WEB_SEARCH_AUTH_HEADER,
    webSearchResults: intOrRaw(env.WEB_SEARCH_RESULTS),
    webSearchTimeoutMs: intOrRaw(env.WEB_SEARCH_TIMEOUT_MS),
    // Multi-provider MCP web search. Keys are optional; the manager skips a
    // provider that requires one and has none configured.
    webSearchEnabled: env.WEB_SEARCH_ENABLED,
    webSearchFallback: env.WEB_SEARCH_FALLBACK,
    webSearchProviders: env.WEB_SEARCH_PROVIDERS,
    webSearchDisabled: env.WEB_SEARCH_DISABLED,
    webMcpTimeoutMs: intOrRaw(env.WEB_MCP_TIMEOUT_MS),
    webMcpMaxRetries: intOrRaw(env.WEB_MCP_MAX_RETRIES),
    webMcpDebug: env.WEB_MCP_DEBUG,
    youApiKey: env.YDC_API_KEY || env.YOU_API_KEY,
    firecrawlApiKey: env.FIRECRAWL_API_KEY,
    tavilyApiKey: env.TAVILY_API_KEY,
    duckduckgoMcpEnabled: env.DUCKDUCKGO_MCP_ENABLED,
    duckduckgoMcpCommand: env.DUCKDUCKGO_MCP_COMMAND,
    duckduckgoMcpArgs: env.DUCKDUCKGO_MCP_ARGS,
    allowShell: env.AGENT_ALLOW_SHELL,
    historyDir: env.AGENT_HISTORY_DIR,
    logDir: env.AGENT_LOG_DIR,
    debug: env.AGENT_DEBUG,
    cwd,
  };
}

/** Verify the Node.js runtime is new enough for the APIs used here. */
export function checkRuntime({ nodeVersion = process.versions.node } = {}) {
  const major = Number.parseInt(nodeVersion.split('.')[0], 10);
  const warnings = [];
  if (!Number.isFinite(major) || major < 22) {
    throw new ConfigError(
      `Node.js ${nodeVersion} is too old. Ryuu Agent CLI requires Node.js 22+ (target: Node.js 25.x).`,
      { nodeVersion },
    );
  }
  if (major < 25) {
    warnings.push(`Node.js ${nodeVersion} detected. Ryuu Agent CLI targets Node.js 25.x; older majors are untested.`);
  }
  return { major, warnings };
}
