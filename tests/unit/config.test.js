import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { buildRawConfig } from '../../src/config/load.js';
import { describeConfig, validateConfig } from '../../src/config/validate.js';
import { makeTempDir } from '../helpers.js';

async function tempWorkspace() {
  return makeTempDir('ryuu-config-');
}

/** Minimal config.json contents with a valid NVIDIA key. */
const baseSettings = () => ({
  provider: 'nvidia',
  providers: { nvidia: { apiKey: 'nvapi-valid-key-123456' } },
});

const configFor = (settings, root) => validateConfig(buildRawConfig(settings, { cwd: root }), { cwd: root });

test('valid config gets documented defaults', async () => {
  const root = await tempWorkspace();
  try {
    const { config, warnings } = configFor(baseSettings(), root);
    assert.equal(config.model, 'minimaxai/minimax-m3.1-flash');
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

test('a config.json without a key fails with an actionable message', async () => {
  const root = await tempWorkspace();
  try {
    const raw = buildRawConfig({}, { cwd: root });
    assert.throws(
      () => validateConfig(raw, { cwd: root }),
      (error) =>
        error.code === 'CONFIG_INVALID' &&
        /Provider nvidia has no API key/.test(error.message) &&
        /providers\.nvidia\.apiKey/.test(error.message) &&
        /ryuu --settings/.test(error.message),
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
    const raw = buildRawConfig(
      { provider: 'nvidia', providers: { nvidia: { apiKey: 'YOUR_NVIDIA_API_KEY' } } },
      { cwd: root },
    );
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
    const settings = baseSettings();
    settings.providers.nvidia.baseURL = 'ftp://example.com';
    settings.agent = {
      maxSteps: -1,
      maxOutputTokens: 999999,
      approvalPolicy: 'yolo',
      logLevel: 'loud',
      allowShell: 'maybe',
    };
    assert.throws(
      () => configFor(settings, root),
      (error) => {
        assert.equal(error.code, 'CONFIG_INVALID');
        assert.match(error.message, /maxSteps must be between/);
        assert.match(error.message, /maxOutputTokens must be between/);
        assert.match(error.message, /agent\.approvalPolicy/);
        assert.match(error.message, /agent\.logLevel/);
        assert.match(error.message, /providers\.nvidia\.baseURL/);
        assert.match(error.message, /agent\.allowShell/);
        return true;
      },
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('missing workspace is rejected', async () => {
  const raw = {
    ...buildRawConfig(baseSettings(), { cwd: '/' }),
    workspace: '/definitely/not/a/real/workspace-xyz',
  };
  assert.throws(() => validateConfig(raw, { cwd: '/' }), /Workspace does not exist/);
});

test('describeConfig never exposes the key', async () => {
  const root = await tempWorkspace();
  try {
    const { config } = configFor(baseSettings(), root);
    const described = describeConfig(config);
    assert.equal(described.apiKey, 'set (redacted)');
    assert.equal(described.apiKeyPath, 'providers.nvidia.apiKey');
    assert.ok(!JSON.stringify(described).includes('nvapi-valid-key-123456'));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('web search defaults to keyless providers and adds Serper when its key is set', async () => {
  const root = await tempWorkspace();
  try {
    const { config: disabled } = configFor(baseSettings(), root);
    assert.equal(disabled.webSearchApiKey, '');
    assert.equal(disabled.webSearchEndpoint, 'https://google.serper.dev/search');
    assert.equal(disabled.webSearchAuthHeader, 'X-API-KEY');
    assert.equal(disabled.webSearchResults, 5);
    assert.equal(disabled.webSearchTimeoutMs, 15000);
    assert.deepEqual(disabled.webSearchProviders, ['you', 'firecrawl', 'duckduckgo', 'tavily']);
    assert.match(describeConfig(disabled).webSearch, /you → firecrawl/);
    assert.equal(describeConfig(disabled).webSearchKeys.serper, false);

    const settings = baseSettings();
    settings.webSearch = {
      serperApiKey: 'sk-live-search-key',
      results: 3,
      authHeader: 'authorization',
      endpoint: 'https://api.example.dev/serp?x=1',
    };
    const { config } = configFor(settings, root);
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
    const settings = baseSettings();
    settings.webSearch = {
      providers: ['you', 'tavily'],
      disabled: ['tavily'],
      fallback: false,
      mcpTimeoutMs: 4000,
      mcpMaxRetries: 2,
      tavilyApiKey: 'tvly-real-key',
    };
    const { config, warnings } = configFor(settings, root);
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
    const settings = baseSettings();
    settings.webSearch = { providers: 'you,notreal', mcpTimeoutMs: 10 };
    assert.throws(
      () => configFor(settings, root),
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
    const settings = baseSettings();
    settings.webSearch = { tavilyApiKey: 'your-tavily-api-key', firecrawlApiKey: 'changeme', duckduckgoEnabled: true };
    const { config, warnings } = configFor(settings, root);
    assert.equal(config.tavilyApiKey, '');
    assert.equal(config.firecrawlApiKey, '');
    assert.equal(config.duckduckgoMcpEnabled, true);
    assert.ok(warnings.some((warning) => warning.includes('webSearch.tavilyApiKey looks like a placeholder')));
    assert.ok(warnings.some((warning) => warning.includes('DuckDuckGo MCP is enabled')));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('web search can be disabled entirely without breaking startup', async () => {
  const root = await tempWorkspace();
  try {
    const settings = baseSettings();
    settings.webSearch = { enabled: false, providers: [] };
    const { config } = configFor(settings, root);
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
    const settings = baseSettings();
    settings.webSearch = {
      serperApiKey: 'sk-test',
      endpoint: 'ftp://search.example.com',
      authHeader: 'Cookie',
      results: 50,
    };
    assert.throws(
      () => configFor(settings, root),
      (error) => {
        assert.match(error.message, /webSearch\.endpoint/);
        assert.match(error.message, /webSearch\.authHeader/);
        assert.match(error.message, /webSearchResults must be between/);
        return true;
      },
    );

    const placeholder = baseSettings();
    placeholder.webSearch = { serperApiKey: 'YOUR_SEARCH_API_KEY', endpoint: 'http://localhost:8080/search' };
    const { config, warnings } = configFor(placeholder, root);
    assert.equal(config.webSearchApiKey, '', 'a placeholder key disables the tool instead of failing startup');
    assert.ok(warnings.some((warning) => /webSearch\.serperApiKey looks like a placeholder/.test(warning)));
    assert.ok(warnings.some((warning) => /plain http/.test(warning)));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('agent settings in config.json reach the validated config', async () => {
  const root = await tempWorkspace();
  try {
    const settings = baseSettings();
    settings.agent = {
      maxSteps: 9,
      approvalPolicy: 'auto',
      logLevel: 'warn',
      allowShell: true,
      debug: true,
      historyDir: '.state/history',
      logDir: '.state/logs',
    };
    const { config, warnings } = configFor(settings, root);
    assert.equal(config.maxSteps, 9);
    assert.equal(config.approvalPolicy, 'auto');
    assert.equal(config.logLevel, 'warn');
    assert.equal(config.allowShell, true);
    assert.equal(config.debug, true);
    assert.equal(config.historyDir, `${config.workspace}/.state/history`);
    assert.equal(config.logDir, `${config.workspace}/.state/logs`);
    assert.ok(warnings.some((warning) => /agent\.allowShell=true/.test(warning)));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
