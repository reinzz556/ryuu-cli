import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { buildRawConfig, loadEnvFile } from '../../src/config/load.js';
import { describeConfig, validateConfig } from '../../src/config/validate.js';
import { makeTempDir } from '../helpers.js';

async function tempWorkspace() {
  return makeTempDir('ryuu-config-');
}

const baseEnv = (root) => ({
  NVIDIA_API_KEY: 'nvapi-valid-key-123456',
  AGENT_WORKSPACE: root,
});

test('valid config gets documented defaults', async () => {
  const root = await tempWorkspace();
  try {
    const raw = buildRawConfig(baseEnv(root), { cwd: root });
    const { config, warnings } = validateConfig(raw, { cwd: root });
    assert.equal(config.model, 'deepseek-ai/deepseek-v4.1-flash');
    assert.equal(config.baseURL, 'https://integrate.api.nvidia.com/v1');
    assert.equal(config.maxSteps, 0);
    assert.equal(config.maxOutputTokens, 4096);
    assert.equal(config.approvalPolicy, 'ask');
    assert.equal(config.workspace, fs.realpathSync(root));
    assert.deepEqual(warnings, []);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('missing API key fails with actionable message', async () => {
  const root = await tempWorkspace();
  try {
    const raw = buildRawConfig({ AGENT_WORKSPACE: root }, { cwd: root });
    assert.throws(
      () => validateConfig(raw, { cwd: root }),
      (error) => error.code === 'CONFIG_INVALID' && /NVIDIA_API_KEY is not set/.test(error.message),
    );
    // Doctor mode can validate without a key.
    const { config } = validateConfig(raw, { requireApiKey: false, cwd: root });
    assert.equal(config.apiKey, '');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('placeholder key is rejected and never echoed', async () => {
  const root = await tempWorkspace();
  try {
    const raw = buildRawConfig({ ...baseEnv(root), NVIDIA_API_KEY: 'YOUR_NVIDIA_API_KEY' }, { cwd: root });
    assert.throws(
      () => validateConfig(raw, { cwd: root }),
      (error) => /placeholder/.test(error.message) && !error.message.includes('YOUR_NVIDIA_API_KEY'),
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('bounds and enums are validated with all issues collected', async () => {
  const root = await tempWorkspace();
  try {
    const raw = buildRawConfig(
      {
        ...baseEnv(root),
        AGENT_MAX_STEPS: '-1',
        AGENT_MAX_OUTPUT_TOKENS: '999999',
        AGENT_APPROVAL_POLICY: 'yolo',
        LOG_LEVEL: 'loud',
        NVIDIA_BASE_URL: 'ftp://example.com',
        AGENT_ALLOW_SHELL: 'maybe',
      },
      { cwd: root },
    );
    assert.throws(
      () => validateConfig(raw, { cwd: root }),
      (error) => {
        assert.equal(error.code, 'CONFIG_INVALID');
        assert.match(error.message, /maxSteps must be between/);
        assert.match(error.message, /maxOutputTokens must be between/);
        assert.match(error.message, /AGENT_APPROVAL_POLICY/);
        assert.match(error.message, /LOG_LEVEL/);
        assert.match(error.message, /NVIDIA_BASE_URL/);
        assert.match(error.message, /AGENT_ALLOW_SHELL/);
        return true;
      },
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('missing workspace is rejected', async () => {
  const raw = buildRawConfig(
    { NVIDIA_API_KEY: 'nvapi-valid-key-123456', AGENT_WORKSPACE: '/definitely/not/a/real/workspace-xyz' },
    { cwd: '/' },
  );
  assert.throws(() => validateConfig(raw, { cwd: '/' }), /Workspace does not exist/);
});

test('describeConfig never exposes the key', async () => {
  const root = await tempWorkspace();
  try {
    const raw = buildRawConfig(baseEnv(root), { cwd: root });
    const { config } = validateConfig(raw, { cwd: root });
    const described = describeConfig(config);
    assert.equal(described.apiKey, 'set (redacted)');
    assert.ok(!JSON.stringify(described).includes('nvapi-valid-key-123456'));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('web search defaults to keyless providers and adds Serper when SEARCH_API_KEY is set', async () => {
  const root = await tempWorkspace();
  try {
    const disabled = validateConfig(buildRawConfig(baseEnv(root), { cwd: root }), { cwd: root }).config;
    assert.equal(disabled.webSearchApiKey, '');
    assert.equal(disabled.webSearchEndpoint, 'https://google.serper.dev/search');
    assert.equal(disabled.webSearchAuthHeader, 'X-API-KEY');
    assert.equal(disabled.webSearchResults, 5);
    assert.equal(disabled.webSearchTimeoutMs, 15000);
    assert.deepEqual(disabled.webSearchProviders, ['you', 'firecrawl', 'duckduckgo', 'tavily']);
    assert.match(describeConfig(disabled).webSearch, /you → firecrawl/);
    assert.equal(describeConfig(disabled).webSearchKeys.serper, false);

    const raw = buildRawConfig(
      {
        ...baseEnv(root),
        SEARCH_API_KEY: 'sk-live-search-key',
        WEB_SEARCH_RESULTS: '3',
        WEB_SEARCH_AUTH_HEADER: 'authorization',
        WEB_SEARCH_ENDPOINT: 'https://api.example.dev/serp?x=1',
      },
      { cwd: root },
    );
    const { config } = validateConfig(raw, { cwd: root });
    assert.equal(config.webSearchApiKey, 'sk-live-search-key');
    assert.equal(config.webSearchAuthHeader, 'Authorization');
    assert.equal(config.webSearchResults, 3);
    assert.equal(config.webSearchEndpoint, 'https://api.example.dev/serp?x=1');
    assert.equal(config.webSearchProviders[0], 'serper');
    assert.equal(describeConfig(config).webSearchKeys.serper, true);
    const described = JSON.stringify(describeConfig(config));
    assert.match(described, /api\.example\.dev/);
    assert.ok(!described.includes('sk-live-search-key'), 'the search key must never be printed');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('web search provider order, disabling and fallback are configurable', async () => {
  const root = await tempWorkspace();
  try {
    const raw = buildRawConfig(
      {
        ...baseEnv(root),
        WEB_SEARCH_PROVIDERS: ' you , tavily ',
        WEB_SEARCH_DISABLED: 'tavily',
        WEB_SEARCH_FALLBACK: 'false',
        WEB_MCP_TIMEOUT_MS: '4000',
        WEB_MCP_MAX_RETRIES: '2',
        TAVILY_API_KEY: 'tvly-real-key',
      },
      { cwd: root },
    );
    const { config, warnings } = validateConfig(raw, { cwd: root });
    assert.deepEqual(config.webSearchProviders, ['you', 'tavily']);
    assert.deepEqual(config.webSearchDisabled, ['tavily']);
    assert.equal(config.webSearchFallback, false);
    assert.equal(config.webMcpTimeoutMs, 4000);
    assert.equal(config.webMcpMaxRetries, 2);
    assert.equal(config.tavilyApiKey, 'tvly-real-key');
    assert.ok(!JSON.stringify(describeConfig(config)).includes('tvly-real-key'));
    assert.ok(!warnings.some((warning) => warning.includes('tvly-real-key')));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('unknown provider ids and impossible timeouts fail loudly', async () => {
  const root = await tempWorkspace();
  try {
    const raw = buildRawConfig(
      { ...baseEnv(root), WEB_SEARCH_PROVIDERS: 'you,notreal', WEB_MCP_TIMEOUT_MS: '10' },
      { cwd: root },
    );
    assert.throws(
      () => validateConfig(raw, { cwd: root }),
      (error) => {
        assert.match(error.message, /unknown provider/);
        assert.match(error.message, /webMcpTimeoutMs/);
        return true;
      },
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('placeholder provider keys are ignored and reported without leaking them', async () => {
  const root = await tempWorkspace();
  try {
    const raw = buildRawConfig(
      {
        ...baseEnv(root),
        TAVILY_API_KEY: 'your-tavily-api-key',
        FIRECRAWL_API_KEY: 'changeme',
        DUCKDUCKGO_MCP_ENABLED: 'true',
      },
      { cwd: root },
    );
    const { config, warnings } = validateConfig(raw, { cwd: root });
    assert.equal(config.tavilyApiKey, '');
    assert.equal(config.firecrawlApiKey, '');
    assert.equal(config.duckduckgoMcpEnabled, true);
    assert.ok(warnings.some((warning) => warning.includes('TAVILY_API_KEY looks like a placeholder')));
    assert.ok(warnings.some((warning) => warning.includes('DuckDuckGo MCP is enabled')));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('web search can be disabled entirely without breaking startup', async () => {
  const root = await tempWorkspace();
  try {
    const raw = buildRawConfig(
      { ...baseEnv(root), WEB_SEARCH_ENABLED: 'false', WEB_SEARCH_PROVIDERS: 'none' },
      { cwd: root },
    );
    const { config } = validateConfig(raw, { cwd: root });
    assert.equal(config.webSearchEnabled, false);
    assert.deepEqual(config.webSearchProviders, []);
    assert.match(describeConfig(config).webSearch, /disabled/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('web search rejects a bad endpoint/header and ignores a placeholder key', async () => {
  const root = await tempWorkspace();
  try {
    const invalid = buildRawConfig(
      {
        ...baseEnv(root),
        SEARCH_API_KEY: 'sk-test',
        WEB_SEARCH_ENDPOINT: 'ftp://search.example.com',
        WEB_SEARCH_AUTH_HEADER: 'Cookie',
        WEB_SEARCH_RESULTS: '50',
      },
      { cwd: root },
    );
    assert.throws(
      () => validateConfig(invalid, { cwd: root }),
      (error) => {
        assert.match(error.message, /WEB_SEARCH_ENDPOINT/);
        assert.match(error.message, /WEB_SEARCH_AUTH_HEADER/);
        assert.match(error.message, /webSearchResults must be between/);
        return true;
      },
    );

    const placeholder = buildRawConfig(
      { ...baseEnv(root), SEARCH_API_KEY: 'YOUR_SEARCH_API_KEY', WEB_SEARCH_ENDPOINT: 'http://localhost:8080/search' },
      { cwd: root },
    );
    const { config, warnings } = validateConfig(placeholder, { cwd: root });
    assert.equal(config.webSearchApiKey, '', 'a placeholder key disables the tool instead of failing startup');
    assert.ok(warnings.some((warning) => /SEARCH_API_KEY looks like a placeholder/.test(warning)));
    assert.ok(warnings.some((warning) => /plain http/.test(warning)));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('loadEnvFile loads values without overriding existing env', async () => {
  const dir = await tempWorkspace();
  const key = `RYUU_TEST_ENV_${Date.now()}`;
  const file = path.join(dir, '.env');
  try {
    await fsp.writeFile(file, `${key}=fromfile\n`);
    if (process.env[key] !== undefined) delete process.env[key];
    const result = loadEnvFile({ cwd: dir });
    assert.deepEqual(result.loaded, [file]);
    assert.equal(process.env[key], 'fromfile');

    process.env[key] = 'existing';
    await fsp.writeFile(file, `${key}=fromfile2\n`);
    loadEnvFile({ cwd: dir });
    assert.equal(process.env[key], 'existing');
  } finally {
    delete process.env[key];
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('loadEnvFile falls back to the installed CLI env when the workspace has none', async () => {
  const dir = await tempWorkspace();
  const key = `RYUU_FALLBACK_${Date.now()}`;
  const fallback = path.join(dir, 'install.env');
  try {
    await fsp.writeFile(fallback, `${key}=fromfallback\n`);
    if (process.env[key] !== undefined) delete process.env[key];
    const result = loadEnvFile({ cwd: path.join(dir, 'project-without-env'), fallbackFile: fallback });
    assert.deepEqual(result.loaded, [fallback]);
    assert.equal(process.env[key], 'fromfallback');
  } finally {
    delete process.env[key];
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
