import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RIVER_DEFAULT_REASONING_EFFORT,
  RIVER_MODEL_REASONING,
  describeReasoning,
  normalizeReasoningEffort,
  resolveReasoningEffort,
  riverRequestExtras,
} from '../../src/providers/river.js';
import { NvidiaProvider } from '../../src/providers/nvidia.js';
import { buildRawConfig } from '../../src/config/load.js';
import { validateConfig } from '../../src/config/validate.js';
import { selectionFor } from '../../src/providers/index.js';
import { testConfig } from '../helpers.js';

const DEEPSEEK = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';

/** Provider pointed at River with a fake client that records the request body. */
function riverProvider(overrides = {}, { env = {} } = {}) {
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  let body = null;
  const client = {
    chat: {
      completions: {
        create: async (request) => {
          body = request;
          return {
            id: 'chatcmpl-river',
            model: request.model,
            choices: [{ message: { role: 'assistant', content: '391', reasoning_content: 'seventeen times' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          };
        },
      },
    },
  };
  const config = {
    ...testConfig(process.cwd()),
    providerId: 'river',
    providerName: 'River AI',
    apiKey: 'rv_test_key',
    apiKeyPath: 'providers.river.apiKey',
    baseURL: 'https://api.river.ai/v1',
    model: DEEPSEEK,
    maxRetries: 0,
    ...overrides,
  };
  const provider = new NvidiaProvider(config, { client });
  return {
    provider,
    config,
    requestBody: () => body,
    restore: () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

test('deepseek on River gets reasoning_effort even when the model default is off', async () => {
  const env = { RYUU_RIVER_REASONING_EFFORT: '', RYUU_REASONING_EFFORT: '' };
  const { provider, requestBody, restore } = riverProvider({}, { env });
  try {
    const result = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(requestBody().reasoning_effort, RIVER_DEFAULT_REASONING_EFFORT);
    assert.equal(result.reasoning, 'seventeen times');
  } finally {
    restore();
  }
});

test('an explicit effort is sent verbatim, and off sends nothing', async () => {
  const silent = { RYUU_RIVER_REASONING_EFFORT: '', RYUU_REASONING_EFFORT: '' };
  const cases = [
    [{ reasoningEffort: 'max' }, 'max'],
    [{ reasoningEffort: 'low' }, 'low'],
    // DeepSeek documents "none", so an explicit off is sent instead of omitted.
    [{ reasoningEffort: 'off' }, 'none'],
    [{ thinking: false }, 'none'],
  ];
  for (const [patch, expected] of cases) {
    const { provider, requestBody, restore } = riverProvider(patch, { env: silent });
    try {
      await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(requestBody().reasoning_effort ?? null, expected, JSON.stringify(patch));
    } finally {
      restore();
    }
  }
});

test('the environment override wins over config.json', () => {
  const env = { RYUU_RIVER_REASONING_EFFORT: 'low', RYUU_REASONING_EFFORT: '' };
  const effort = resolveReasoningEffort({ model: DEEPSEEK, reasoningEffort: 'max' }, { env });
  assert.equal(effort, 'low');
});

test('models that already reason by default get no forced effort', () => {
  assert.equal(resolveReasoningEffort({ model: 'GLM-5.3' }, { env: {} }), null);
  assert.equal(resolveReasoningEffort({ model: 'zai-org/GLM-5.3-Flash' }, { env: {} }), null);
  assert.equal(RIVER_MODEL_REASONING['GLM-5.3'].onByDefault, true);
});

test('an unsupported level degrades to the model default instead of failing the request', () => {
  const effort = resolveReasoningEffort({ model: 'Qwen/Qwen3.8-27B-FP8', reasoningEffort: 'high' }, { env: {} });
  assert.equal(effort, 'xhigh');
  assert.equal(resolveReasoningEffort({ model: 'Qwen/Qwen3.8-27B-FP8', reasoningEffort: 'medium' }, { env: {} }), 'medium');
});

test('effort words normalize to the documented menu', () => {
  assert.equal(normalizeReasoningEffort('HIGH'), 'high');
  assert.equal(normalizeReasoningEffort('off'), 'none');
  assert.equal(normalizeReasoningEffort(true), RIVER_DEFAULT_REASONING_EFFORT);
  assert.equal(normalizeReasoningEffort(false), 'none');
  assert.equal(normalizeReasoningEffort('nonsense'), null);
});

test('a hand-written extraProviders entry for the River host gets the same extras', () => {
  const extras = riverRequestExtras({ providerId: 'myriver', model: DEEPSEEK }, { env: {} });
  assert.equal(extras.reasoning_effort, RIVER_DEFAULT_REASONING_EFFORT);
  // Pass-through fields from a user entry are copied verbatim.
  assert.deepEqual(
    riverRequestExtras({ model: DEEPSEEK, requestParams: { top_p: 0.9 } }, { env: {} }).top_p,
    0.9,
  );
});

test('a provider without a registered client sends only the standard fields', async () => {
  let body = null;
  const client = {
    chat: {
      completions: {
        create: async (request) => {
          body = request;
          return {
            id: 'x',
            model: request.model,
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        },
      },
    },
  };
  const provider = new NvidiaProvider(
    { ...testConfig(process.cwd()), providerId: 'myproxy', apiKey: 'x', baseURL: 'https://proxy.invalid/v1', model: 'model-a' },
    { client },
  );
  await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'stream']);
});

test('the effort stored next to the key in config.json reaches the request', () => {
  const raw = buildRawConfig({
    provider: 'river',
    providers: { river: { apiKey: 'rv_test_key', reasoningEffort: 'max' } },
  });
  const { config } = validateConfig(raw, { cwd: process.cwd() });
  assert.equal(config.reasoningEffort, 'max');
  assert.equal(resolveReasoningEffort(config, { env: {} }), 'max');
});

test('switching provider drops the vendor fields of the provider left behind', async () => {
  const raw = buildRawConfig({
    provider: 'river',
    providers: {
      river: { apiKey: 'rv_test_key', reasoningEffort: 'max' },
      nvidia: { apiKey: 'nvapi-abc123456' },
    },
  });
  const { config } = validateConfig(raw, { cwd: process.cwd() });
  const bodies = [];
  const client = {
    chat: {
      completions: {
        create: async (request) => {
          bodies.push(request);
          return {
            id: 'x',
            model: request.model,
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        },
      },
    },
  };
  const provider = new NvidiaProvider(config, { client });
  await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(bodies[0].reasoning_effort, 'max');

  // NVIDIA has no vendor field of its own: River's effort must not leak into it.
  provider.updateSelection(selectionFor(config, 'nvidia'));
  await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(bodies[1].reasoning_effort, undefined);

  // Switching back restores River's own setting.
  provider.updateSelection(selectionFor(config, 'river'));
  await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(bodies[2].reasoning_effort, 'max');
});

test('/status describes the reasoning effort that will be sent', () => {
  assert.equal(
    describeReasoning({ providerId: 'river', model: DEEPSEEK }, { env: {} }),
    'reasoning_effort: high',
  );
  assert.equal(
    describeReasoning({ providerId: 'river', model: DEEPSEEK, reasoningEffort: 'none' }, { env: {} }),
    'off (reasoning_effort: none)',
  );
  // A provider that needs no effort field stays quiet.
  assert.equal(describeReasoning({ providerId: 'nvidia', model: 'z-ai/glm-5.3' }, { env: {} }), null);
});