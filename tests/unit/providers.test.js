import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  BUILTIN_PROVIDERS,
  DEFAULT_MODEL,
  MODEL_CATALOG,
  modelsFor,
  normalizeModelId,
  parseExtraProviders,
  providerById,
  resolveProviderId,
} from '../../src/providers/catalog.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { createActiveProvider, providerRegistry, selectionFor } from '../../src/providers/index.js';
import { NvidiaProvider } from '../../src/providers/nvidia.js';
import { buildRawConfig } from '../../src/config/load.js';
import { describeConfig, validateConfig } from '../../src/config/validate.js';
import { createLogger } from '../../src/services/logger.js';
import { Agent } from '../../src/agent/agent.js';
import { buildToolRegistry } from '../../src/tools/index.js';
import { parseArgs } from '../../src/index.js';
import {
  addCustomModel,
  applyPersistedModel,
  applyPersistedProvider,
  readCustomModels,
  readProviderModel,
  readProviderPreference,
  stateDirFor,
  writeModelPreference,
  writeProviderPreference,
} from '../../src/services/preferences.js';
import { createTestWorkspace, makeTempDir, ScriptedProvider, response, testConfig } from '../helpers.js';
import { createCommands, parseCommandLine } from '../../src/cli/commands.js';
import { Workspace } from '../../src/services/workspace.js';

const TOKENHARBOR_KEY = 'th-test-key-abcdef123456';

/** Validated config for Token Harbor, built from config.json contents. */
async function tokenHarborConfig({ settings = {}, raw: rawOverrides = {} } = {}) {
  const root = await makeTempDir('ryuu-tokenharbor-');
  const document = {
    ...settings,
    provider: settings.provider ?? 'tokenharbor',
    providers: { tokenharbor: { apiKey: TOKENHARBOR_KEY }, ...(settings.providers || {}) },
  };
  const raw = { ...buildRawConfig(document, { cwd: root }), ...rawOverrides };
  const { config, warnings } = validateConfig(raw, { cwd: root });
  return {
    config,
    warnings,
    root,
    async cleanup() {
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const tokenHarborCompletion = {
  id: 'chatcmpl-th-1',
  model: 'deepseek-v4.1-flash:free',
  choices: [
    {
      message: {
        role: 'assistant',
        content: 'Sky is blue because of Rayleigh scattering.',
        tool_calls: [
          { id: 'call_th_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 },
};

test('catalog declares Token Harbor and keeps the existing NVIDIA provider', () => {
  const tokenHarbor = BUILTIN_PROVIDERS.find((provider) => provider.id === 'tokenharbor');
  assert.equal(tokenHarbor.name, 'Token Harbor');
  assert.equal(tokenHarbor.baseURL, 'https://tokenharbor.ai/v1');
  assert.equal(tokenHarbor.defaultModel, 'deepseek-v4.1-flash:free');
  assert.deepEqual(tokenHarbor.models.map((model) => model.id), ['deepseek-v4.1-flash:free']);
  assert.equal(tokenHarbor.models[0].name, 'DeepSeek V4.1 Flash Free');
  assert.equal(tokenHarbor.capabilities.tools, true);
  assert.equal(tokenHarbor.capabilities.streaming, true);
  assert.equal(tokenHarbor.capabilities.multimodal, false);

  const nvidia = BUILTIN_PROVIDERS.find((provider) => provider.id === 'nvidia');
  assert.equal(nvidia.defaultModel, DEFAULT_MODEL);
  assert.equal(DEFAULT_MODEL, 'minimaxai/minimax-m3.1-flash');
  assert.deepEqual(nvidia.models.map((model) => model.id), MODEL_CATALOG, 'the catalog is listed in order');
  assert.equal(MODEL_CATALOG[5], 'minimaxai/minimax-m3.1-flash', 'the default is the 6th model');
  assert.equal(nvidia.models[5].default, true);
  assert.equal(nvidia.models.filter((model) => model.default).length, 1, 'only one model is marked default');

  const entries = modelsFor({ models: nvidia.models }, ['custom/model']);
  assert.equal(entries.at(-1).id, 'custom/model');
  assert.equal(entries.at(-1).added, true);
  assert.equal(normalizeModelId('deepseek-v4.1-flash:free'), 'deepseek-v4.1-flash:free');
  assert.equal(normalizeModelId('bad id'), null);
});

test('selects Token Harbor with its documented defaults and no warnings', async () => {
  const ctx = await tokenHarborConfig();
  try {
    assert.equal(ctx.config.providerId, 'tokenharbor');
    assert.equal(ctx.config.providerName, 'Token Harbor');
    assert.equal(ctx.config.model, 'deepseek-v4.1-flash:free');
    assert.equal(ctx.config.baseURL, 'https://tokenharbor.ai/v1');
    assert.equal(ctx.config.apiKeyPath, 'providers.tokenharbor.apiKey');
    assert.equal(ctx.config.apiKey, TOKENHARBOR_KEY);
    assert.equal(ctx.config.capabilities.tools, true);
    assert.deepEqual(ctx.warnings, []);

    const nvidia = providerById(ctx.config.providers, 'nvidia');
    assert.equal(nvidia.apiKey, '', 'the NVIDIA key is not invented');
    assert.equal(providerById(ctx.config.providers, 'tokenharbor').apiKey, TOKENHARBOR_KEY);

    const described = JSON.stringify(describeConfig(ctx.config));
    assert.match(described, /Token Harbor/);
    assert.match(described, /tokenharbor\*: key set/);
    assert.match(described, /nvidia: no key \(providers\.nvidia\.apiKey\)/);
    assert.ok(!described.includes(TOKENHARBOR_KEY), 'the key must never be printed');
  } finally {
    await ctx.cleanup();
  }
});

test('a missing Token Harbor key names the setting instead of calling the API', async () => {
  const root = await makeTempDir('ryuu-tokenharbor-missing-');
  try {
    const raw = buildRawConfig({ provider: 'tokenharbor' }, { cwd: root });
    assert.throws(
      () => validateConfig(raw, { cwd: root }),
      (error) =>
        error.code === 'CONFIG_INVALID' &&
        /Provider tokenharbor has no API key/.test(error.message) &&
        /providers\.tokenharbor\.apiKey/.test(error.message) &&
        /Token Harbor/.test(error.message),
    );

    const { config } = validateConfig(raw, { requireApiKey: false, cwd: root });
    assert.equal(config.apiKey, '');
    assert.equal(config.providerId, 'tokenharbor');
    assert.throws(
      () => new NvidiaProvider(config),
      (error) => error.code === 'AUTH_MISSING' && /providers\.tokenharbor\.apiKey/.test(error.message),
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('provider auto-selection prefers nvidia, then the first provider with a key', async () => {
  const root = await makeTempDir('ryuu-provider-auto-');
  try {
    const resolve = (settings) =>
      validateConfig(buildRawConfig(settings, { cwd: root }), { cwd: root }).config;

    assert.equal(
      resolve({ providers: { nvidia: { apiKey: 'nvapi-abc123456' }, tokenharbor: { apiKey: TOKENHARBOR_KEY } } }).providerId,
      'nvidia',
    );
    assert.equal(resolve({ providers: { tokenharbor: { apiKey: TOKENHARBOR_KEY } } }).providerId, 'tokenharbor');
    assert.equal(
      resolve({
        provider: 'tokenharbor',
        providers: { nvidia: { apiKey: 'nvapi-abc123456' }, tokenharbor: { apiKey: TOKENHARBOR_KEY } },
      }).providerId,
      'tokenharbor',
      'an explicit selection wins over the key order',
    );
    assert.throws(
      () => resolve({ provider: 'nvidia', providers: { tokenharbor: { apiKey: TOKENHARBOR_KEY } } }),
      /Provider nvidia has no API key/,
      'explicit selection does not fall back to another provider\'s key',
    );

    const catalog = resolve({ providers: { tokenharbor: { apiKey: TOKENHARBOR_KEY } } }).providers;
    assert.equal(resolveProviderId({ providers: catalog }), 'tokenharbor');
    assert.equal(resolveProviderId({ explicit: 'nvidia', providers: catalog }), 'nvidia');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('unknown providers and malformed model ids are rejected before a request', async () => {
  const root = await makeTempDir('ryuu-provider-invalid-');
  try {
    const raw = buildRawConfig(
      { provider: 'notreal', providers: { tokenharbor: { apiKey: TOKENHARBOR_KEY } } },
      { cwd: root },
    );
    assert.throws(
      () => validateConfig(raw, { cwd: root }),
      (error) => /not a known provider/.test(error.message) && /nvidia, tokenharbor/.test(error.message),
    );

    const badModel = buildRawConfig(
      {
        provider: 'tokenharbor',
        providerModel: { tokenharbor: 'bad model id' },
        providers: { tokenharbor: { apiKey: TOKENHARBOR_KEY } },
      },
      { cwd: root },
    );
    assert.throws(() => validateConfig(badModel, { cwd: root }), /unsupported characters/);

    const unknownModel = {
      ...buildRawConfig({ provider: 'tokenharbor', providers: { tokenharbor: { apiKey: TOKENHARBOR_KEY } } }, { cwd: root }),
      model: 'future-model:free',
    };
    const { config, warnings } = validateConfig(unknownModel, { cwd: root });
    assert.equal(config.model, 'future-model:free', 'a newer model id is allowed');
    assert.ok(warnings.some((warning) => /not listed for provider tokenharbor/.test(warning)));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a user provider can start without models and gets one from /addmodel', () => {
  const issues = [];
  const extras = parseExtraProviders(
    [{ id: 'myproxy', baseURL: 'https://proxy.example/v1', models: [] }],
    issues,
  );
  assert.deepEqual(issues, []);
  assert.equal(extras.length, 1);
  assert.equal(extras[0].defaultModel, null);
  assert.deepEqual(extras[0].models, []);
});

test('a provider entry that redeclares a built-in is ignored, not fatal', () => {
  const issues = [];
  const warnings = [];
  const extras = parseExtraProviders(
    [{ id: 'river', baseURL: 'https://api.river.ai/v1/', models: [] }],
    issues,
    warnings,
  );
  assert.deepEqual(issues, []);
  assert.equal(extras.length, 0);
  assert.match(warnings[0], /redeclares the built-in provider "river"/);
});

test('extraProviders registers an extra provider without touching the agent', async () => {
  const root = await makeTempDir('ryuu-provider-extra-');
  try {
    const definition = {
      id: 'myproxy',
      name: 'My Proxy',
      baseURL: 'https://proxy.example/v1',
      defaultModel: 'model-b',
      models: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b', name: 'Model B' }],
      capabilities: { tools: false, streaming: false, reasoning: false },
    };
    const raw = buildRawConfig(
      {
        provider: 'myproxy',
        extraProviders: [definition],
        providers: { myproxy: { apiKey: 'proxy-secret-key' } },
      },
      { cwd: root },
    );
    const { config } = validateConfig(raw, { cwd: root });
    assert.equal(config.providerId, 'myproxy');
    assert.equal(config.model, 'model-b');
    assert.equal(config.baseURL, 'https://proxy.example/v1');
    assert.equal(config.apiKey, 'proxy-secret-key');
    assert.equal(config.capabilities.tools, false);
    assert.equal(config.capabilities.streaming, false);
    assert.ok(!JSON.stringify(describeConfig(config)).includes('proxy-secret-key'));

    const provider = createActiveProvider(config);
    assert.equal(provider.providerId, 'myproxy');
    assert.equal(provider.model, 'model-b');
    providerRegistry.unregister('myproxy');

    const duplicate = buildRawConfig({ extraProviders: [{ ...definition, id: 'nvidia' }] }, { cwd: root });
    assert.throws(() => validateConfig(duplicate, { cwd: root }), /already registered/);

    const broken = buildRawConfig({ extraProviders: '{oops' }, { cwd: root });
    assert.throws(() => validateConfig(broken, { cwd: root }), /not valid JSON/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('the provider registry instantiates, caches and rejects unknown ids', () => {
  const registry = new ProviderRegistry();
  const seen = [];
  registry.register('demo', (config) => {
    seen.push(config.id);
    return { id: config.id };
  });
  assert.equal(registry.has('demo'), true);
  assert.deepEqual(registry.list(), ['demo']);
  const first = registry.resolve('demo', { id: 'one' });
  const second = registry.resolve('demo', { id: 'two' });
  assert.equal(first, second, 'one instance is reused within a session');
  assert.deepEqual(seen, ['one']);
  assert.equal(registry.get('demo'), first);
  assert.throws(() => registry.resolve('missing'), (error) => error.code === 'UNKNOWN_PROVIDER');
  assert.throws(() => registry.register('', () => ({})), (error) => error.code === 'INVALID_PROVIDER_ID');
  assert.throws(() => registry.register('x', null), (error) => error.code === 'INVALID_PROVIDER_FACTORY');
  registry.unregister('demo');
  assert.equal(registry.has('demo'), false);
});

test('selectionFor validates the provider, its key and the model', async () => {
  const ctx = await tokenHarborConfig();
  try {
    const selection = selectionFor(ctx.config, 'tokenharbor');
    assert.equal(selection.providerId, 'tokenharbor');
    assert.equal(selection.model, 'deepseek-v4.1-flash:free');
    assert.equal(selection.apiKey, TOKENHARBOR_KEY);
    assert.equal(selection.apiKeyPath, 'providers.tokenharbor.apiKey');

    assert.throws(() => selectionFor(ctx.config, 'nvidia'), (error) => error.code === 'AUTH_MISSING');
    assert.throws(() => selectionFor(ctx.config, 'nope'), (error) => error.code === 'UNKNOWN_PROVIDER');
    assert.throws(
      () => selectionFor(ctx.config, 'tokenharbor', { model: 'bad model' }),
      (error) => error.code === 'INVALID_MODEL',
    );
  } finally {
    await ctx.cleanup();
  }
});

test('a Token Harbor request uses its base URL, model id and bearer key', async () => {
  const ctx = await tokenHarborConfig();
  try {
    const captured = [];
    const fetchImpl = async (url, init) => {
      const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers || {});
      captured.push({ url: String(url), auth: headers.get('authorization'), body: JSON.parse(init.body) });
      return jsonResponse(tokenHarborCompletion);
    };
    const provider = new NvidiaProvider(ctx.config, { fetchImpl });
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Why is the sky blue?' }],
      tools: [{ type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object' } } }],
    });

    assert.equal(captured.length, 1);
    assert.equal(captured[0].url, 'https://tokenharbor.ai/v1/chat/completions');
    assert.equal(captured[0].auth, `Bearer ${TOKENHARBOR_KEY}`);
    assert.equal(captured[0].body.model, 'deepseek-v4.1-flash:free');
    assert.equal(captured[0].body.stream, false);
    assert.equal(captured[0].body.tool_choice, 'auto');
    assert.equal(captured[0].body.tools.length, 1);
    assert.equal(result.content, tokenHarborCompletion.choices[0].message.content);
    assert.equal(result.toolCalls[0].name, 'read_file');
    assert.equal(result.toolCalls[0].argumentsText, '{"path":"README.md"}');
    assert.deepEqual(result.usage, { prompt: 21, completion: 9, total: 30 });
  } finally {
    await ctx.cleanup();
  }
});

test('Token Harbor streaming delivers reasoning, content and fragmented tool calls', async () => {
  const ctx = await tokenHarborConfig();
  try {
    const chunks = [
      { id: 'th-stream', model: 'deepseek-v4.1-flash:free', choices: [{ delta: { reasoning_content: 'think ' }, finish_reason: null }] },
      { id: 'th-stream', model: 'deepseek-v4.1-flash:free', choices: [{ delta: { reasoning_content: 'about it' }, finish_reason: null }] },
      { id: 'th-stream', model: 'deepseek-v4.1-flash:free', choices: [{ delta: { content: 'Checking. ' }, finish_reason: null }] },
      {
        id: 'th-stream',
        model: 'deepseek-v4.1-flash:free',
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] }, finish_reason: null }],
      },
      { id: 'th-stream', model: 'deepseek-v4.1-flash:free', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"README.md"}' } }] }, finish_reason: 'tool_calls' }] },
      { id: 'th-stream', model: 'deepseek-v4.1-flash:free', choices: [], usage: { prompt_tokens: 15, completion_tokens: 12, total_tokens: 27 } },
    ];
    let requestBody = null;
    const fetchImpl = async (_url, init) => {
      requestBody = JSON.parse(init.body);
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const provider = new NvidiaProvider(ctx.config, { fetchImpl });
    const reasoning = [];
    const content = [];
    const firstTokens = [];
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Why is the sky blue?' }],
      stream: true,
      onReasoning: (text) => reasoning.push(text),
      onContent: (text) => content.push(text),
      onFirstToken: (payload) => firstTokens.push(payload),
    });

    assert.equal(requestBody.stream, true);
    assert.deepEqual(requestBody.stream_options, { include_usage: true });
    assert.deepEqual(reasoning, ['think ', 'about it']);
    assert.deepEqual(content, ['Checking. ']);
    assert.equal(firstTokens.length, 1);
    assert.equal(result.reasoning, 'think about it');
    assert.equal(result.content, 'Checking. ');
    assert.equal(result.finishReason, 'tool_calls');
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].argumentsText, '{"path":"README.md"}');
    assert.deepEqual(result.usage, { prompt: 15, completion: 12, total: 27 });
  } finally {
    await ctx.cleanup();
  }
});

test('agent respects declared capabilities: no tools and no stream when unsupported', async () => {
  const fixture = await createTestWorkspace();
  try {
    const config = testConfig(fixture.root);
    const registry = buildToolRegistry({
      workspace: fixture.workspace,
      config,
      processes: null,
    });
    const provider = new ScriptedProvider([response({ content: 'done' })]);
    provider.capabilities = { streaming: false, tools: false, reasoning: false, multimodal: false };
    const agent = new Agent({
      provider,
      registry,
      workspace: fixture.workspace,
      config,
      renderer: {},
    });
    await agent.run('say done');
    assert.equal(provider.calls.length, 1);
    assert.deepEqual(provider.calls[0].tools, [], 'tools are not sent to a provider without tool support');
    assert.equal(provider.calls[0].stream, false, 'streaming is not requested when unsupported');
  } finally {
    await fixture.cleanup();
  }
});

test('updateSelection repoints the same instance without rebuilding the agent', async () => {
  const ctx = await tokenHarborConfig({ settings: { providers: { nvidia: { apiKey: 'nvapi-abc123456' } } } });
  try {
    const captured = [];
    const provider = new NvidiaProvider(ctx.config, {
      fetchImpl: async (url, init) => {
        const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers || {});
        captured.push({ url: String(url), auth: headers.get('authorization'), body: JSON.parse(init.body) });
        return jsonResponse(tokenHarborCompletion);
      },
    });
    const original = provider;

    provider.updateSelection(
      selectionFor(ctx.config, 'nvidia', { model: 'nvidia/nemotron-3.5-super-vl-120b-a12b' }),
    );
    assert.equal(provider, original, 'the agent keeps the same provider object');
    assert.equal(provider.providerId, 'nvidia');
    assert.equal(provider.model, 'nvidia/nemotron-3.5-super-vl-120b-a12b');

    await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(captured[0].url, 'https://integrate.api.nvidia.com/v1/chat/completions');
    assert.equal(captured[0].auth, 'Bearer nvapi-abc123456');
    assert.equal(captured[0].body.model, 'nvidia/nemotron-3.5-super-vl-120b-a12b');

    // Switching back works too, and a provider without a key is refused.
    provider.updateSelection(selectionFor(ctx.config, 'tokenharbor'));
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(captured[1].url, 'https://tokenharbor.ai/v1/chat/completions');
    assert.equal(captured[1].auth, `Bearer ${TOKENHARBOR_KEY}`);

    assert.throws(
      () => provider.updateSelection({ providerId: 'nvidia', apiKey: '', apiKeyPath: 'providers.nvidia.apiKey' }),
      (error) => error.code === 'AUTH_MISSING',
    );
  } finally {
    await ctx.cleanup();
  }
});

test('Token Harbor HTTP failures map to actionable codes without leaking the key', async () => {
  const cases = [
    [401, { error: { message: `invalid key ${TOKENHARBOR_KEY}` } }, 'AUTH_INVALID'],
    [403, { error: { message: 'model forbidden' } }, 'AUTH_FORBIDDEN'],
    [404, { error: { message: 'model not found' } }, 'MODEL_NOT_FOUND'],
    [429, { error: { message: 'rate limited' } }, 'RATE_LIMIT'],
    [500, { error: { message: 'upstream down' } }, 'SERVER_ERROR'],
  ];
  for (const [status, body, code] of cases) {
    const ctx = await tokenHarborConfig({ raw: { maxRetries: 0 } });
    try {
      const provider = new NvidiaProvider(ctx.config, {
        fetchImpl: async () => jsonResponse(body, status),
      });
      await assert.rejects(
        provider.chat({ messages: [{ role: 'user', content: 'hi' }] }),
        (error) => {
          assert.equal(error.code, code);
          assert.ok(!error.message.includes(TOKENHARBOR_KEY), 'the key must never appear in an error');
          if (status === 401) assert.match(error.message, /providers\.tokenharbor\.apiKey/);
          return true;
        },
      );
    } finally {
      await ctx.cleanup();
    }
  }
});

test('an empty or invalid provider body is reported as a retryable empty response', async () => {
  const ctx = await tokenHarborConfig({ raw: { maxRetries: 0 } });
  try {
    const provider = new NvidiaProvider(ctx.config, { fetchImpl: async () => jsonResponse({}) });
    await assert.rejects(
      provider.chat({ messages: [{ role: 'user', content: 'hi' }] }),
      (error) => error.code === 'EMPTY_RESPONSE' && error.retryable === true,
    );
  } finally {
    await ctx.cleanup();
  }
});

test('configured provider keys are redacted from the log file', async () => {
  const ctx = await tokenHarborConfig();
  try {
    const logger = createLogger({ ...ctx.config, logLevel: 'debug' }, {
      secrets: ctx.config.providers.map((provider) => provider.apiKey).filter(Boolean),
    });
    logger.error(`authentication failed for ${TOKENHARBOR_KEY}`, {
      apiKey: TOKENHARBOR_KEY,
      provider: ctx.config.providerId,
    });
    const log = await fsp.readFile(path.join(ctx.config.logDir, 'agent.log'), 'utf8');
    assert.ok(!log.includes(TOKENHARBOR_KEY), 'the key must not be written to the log');
    assert.match(log, /REDACTED/);
    assert.match(log, /tokenharbor/);
  } finally {
    await ctx.cleanup();
  }
});

test('model and provider preferences are stored per provider', async () => {
  const dir = stateDirFor(await makeTempDir('ryuu-prefs-provider-'));
  try {
    assert.deepEqual(await readCustomModels(dir, 'tokenharbor'), []);
    assert.equal((await addCustomModel(dir, 'deepseek-next:free', 'tokenharbor')).ok, true);
    assert.deepEqual(await readCustomModels(dir, 'tokenharbor'), ['deepseek-next:free']);
    assert.deepEqual(await readCustomModels(dir, 'nvidia'), [], 'added models do not leak to another provider');

    assert.equal(await writeModelPreference(dir, 'deepseek-next:free', { providerId: 'tokenharbor' }), true);
    assert.equal(await readProviderModel(dir, 'tokenharbor'), 'deepseek-next:free');
    assert.equal(await readProviderModel(dir, 'nvidia'), null, 'each provider remembers its own model');

    assert.equal(await writeProviderPreference(dir, 'tokenharbor'), true);
    assert.equal(await readProviderPreference(dir), 'tokenharbor');

    const raw = { model: 'env/model' };
    assert.equal(await applyPersistedProvider(raw, { stateDir: dir }), true);
    assert.equal(raw.provider, 'tokenharbor');
    assert.equal(
      await applyPersistedProvider(raw, { flagProvider: 'nvidia', stateDir: dir }),
      false,
      'an explicit --provider flag is never overwritten',
    );

    const modelRaw = { model: 'env/model' };
    assert.equal(await applyPersistedModel(modelRaw, { stateDir: dir, providerId: 'tokenharbor' }), true);
    assert.equal(modelRaw.model, 'deepseek-next:free');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

class LineRecorder {
  constructor() {
    this.chunks = [];
  }

  lines(text = '') {
    this.chunks.push(String(text));
  }

  warn(message) {
    this.chunks.push(`[warn] ${message}`);
  }

  get text() {
    return this.chunks.join('\n');
  }
}

test('/provider lists key status, switches provider and keeps secrets hidden', async () => {
  const ctx = await tokenHarborConfig();
  try {
    const renderer = new LineRecorder();
    const switched = [];
    const workspace = new Workspace(ctx.config.workspace);
    const commands = createCommands({
      config: ctx.config,
      workspace,
      registry: { list: () => [], get: () => null },
      processes: { list: () => [], getOutput: () => null },
      sessionStore: { list: async () => [], load: async () => null },
      undo: { size: 0, entries: [], list: () => [] },
      renderer,
      provider: { config: ctx.config },
      interactive: false,
      getAgent: () => null,
      getLastSummary: () => null,
      getActiveTask: () => null,
      confirmLocal: async () => false,
      switchProvider: async (id) => {
        switched.push(id);
        return { providerId: id, providerName: 'NVIDIA Integrate API', model: 'nvidia/nemotron-3.5-super-vl-120b-a12b', persisted: true };
      },
      providerLimitations: () => [],
    });

    await commands.execute(parseCommandLine('/provider'));
    const listing = renderer.text;
    assert.match(listing, /Token Harbor/);
    assert.match(listing, /tokenharbor\*: key set|tokenharbor {2}Token Harbor\s+key set/);
    assert.match(listing, /← current/);
    assert.ok(!listing.includes(TOKENHARBOR_KEY), 'the provider list must never print the key');

    renderer.chunks = [];
    await commands.execute(parseCommandLine('/provider nvidia'));
    assert.deepEqual(switched, ['nvidia']);
    assert.match(renderer.text, /Provider set to NVIDIA Integrate API \(nvidia\)/);
    assert.match(renderer.text, /Conversation history and the worklog were kept/);

    renderer.chunks = [];
    await commands.execute(parseCommandLine('/provider nope'));
    assert.match(renderer.text, /Unknown provider: nope\. Known providers: nvidia, tokenharbor/);
  } finally {
    await ctx.cleanup();
  }
});

test('/model lists the active provider\u2019s models and /addmodel is provider-scoped', async () => {
  const ctx = await tokenHarborConfig();
  try {
    const renderer = new LineRecorder();
    const workspace = new Workspace(ctx.config.workspace);
    const commands = createCommands({
      config: ctx.config,
      workspace,
      registry: { list: () => [], get: () => null },
      processes: { list: () => [], getOutput: () => null },
      sessionStore: { list: async () => [], load: async () => null },
      undo: { size: 0, entries: [], list: () => [] },
      renderer,
      provider: { config: ctx.config },
      interactive: false,
      getAgent: () => null,
      getLastSummary: () => null,
      getActiveTask: () => null,
      confirmLocal: async () => false,
    });

    await commands.execute(parseCommandLine('/model'));
    assert.match(renderer.text, /Provider: Token Harbor \(tokenharbor\)/);
    assert.match(renderer.text, /1 {2}deepseek-v4\.1-flash:free {2}\(DeepSeek V4\.1 Flash Free\) {2}← current/);
    assert.match(renderer.text, /1 built-in · 0 added/);

    renderer.chunks = [];
    await commands.execute(parseCommandLine('/addmodel tokenharbor deepseek-next:free'));
    assert.match(renderer.text, /Added deepseek-next:free to provider tokenharbor \(#2\)/);

    renderer.chunks = [];
    await commands.execute(parseCommandLine('/model'));
    assert.match(renderer.text, /deepseek-next:free {2}\(added\)/);
    assert.match(renderer.text, /1 built-in · 1 added/);

    // The list is scoped to tokenharbor and lives in the workspace prefs file.
    const dir = stateDirFor(ctx.config.workspace);
    assert.deepEqual(await readCustomModels(dir, 'tokenharbor'), ['deepseek-next:free']);
    assert.deepEqual(await readCustomModels(dir, 'nvidia'), []);
  } finally {
    await ctx.cleanup();
  }
});

test('the CLI parses --provider without colliding with existing options', () => {
  const options = parseArgs(['--provider', 'tokenharbor', '--model', 'deepseek-v4.1-flash:free', 'summarize this']);
  assert.equal(options.provider, 'tokenharbor');
  assert.equal(options.model, 'deepseek-v4.1-flash:free');
  assert.equal(options.task, 'summarize this');
  assert.equal(parseArgs(['--provider=tokenharbor', 'task']).provider, 'tokenharbor');
});
