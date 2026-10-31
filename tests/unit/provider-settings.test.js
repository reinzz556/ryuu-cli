import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  addExtraProvider,
  addExtraProviderModel,
  isBuiltinProviderId,
  readExtraProviders,
  removeExtraProvider,
  removeExtraProviderModel,
} from '../../src/services/provider-settings.js';
import { readSettings } from '../../src/config/settings.js';
import { makeTempDir } from '../helpers.js';

/** Run one test against an isolated config.json directory. */
async function withConfig(run) {
  const dir = await makeTempDir('ryuu-provider-settings-');
  const previous = process.env.RYUU_CONFIG_DIR;
  process.env.RYUU_CONFIG_DIR = dir;
  const file = path.join(dir, 'config.json');
  await fsp.writeFile(file, JSON.stringify({ version: 1 }), 'utf8');
  try {
    await run({
      file,
      read: async () => JSON.parse(await fsp.readFile(file, 'utf8')),
    });
  } finally {
    if (previous === undefined) delete process.env.RYUU_CONFIG_DIR;
    else process.env.RYUU_CONFIG_DIR = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('adding a provider stores the URL and optional key, and is idempotent for the key', async () => {
  await withConfig(async ({ read }) => {
    const added = await addExtraProvider({ name: 'myriver', baseURL: 'https://api.river.ai/v1/', apiKey: 'rv-test' });
    assert.equal(added.ok, true);
    assert.equal(added.id, 'myriver');
    assert.equal(added.baseURL, 'https://api.river.ai/v1');
    const saved = await read();
    assert.equal(saved.extraProviders[0].id, 'myriver');
    assert.equal(saved.extraProviders[0].models.length, 0);
    assert.equal(saved.providers.myriver.apiKey, 'rv-test');

    const duplicate = await addExtraProvider({ name: 'myriver', baseURL: 'https://api.river.ai/v1' });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.reason, 'exists');

    const updated = await addExtraProvider({ name: 'myriver', baseURL: 'https://api.river.ai/v1', apiKey: 'rv-new' });
    assert.equal(updated.ok, true);
    assert.equal((await read()).providers.myriver.apiKey, 'rv-new');
    assert.equal((await read()).extraProviders.length, 1);
  });
});

test('invalid names, URLs and built-ins are refused without touching the file', async () => {
  await withConfig(async ({ read }) => {
    assert.equal((await addExtraProvider({ name: 'Bad Name', baseURL: 'https://x/v1' })).reason, 'invalid');
    assert.equal((await addExtraProvider({ name: 'bad', baseURL: 'ftp://x/v1' })).reason, 'url');
    assert.equal((await addExtraProvider({ name: 'bad', baseURL: 'https://user:pass@x/v1' })).reason, 'url');
    assert.equal((await addExtraProvider({ name: 'nvidia', baseURL: 'https://x/v1' })).reason, 'builtin');
    assert.equal((await read()).extraProviders, undefined);
    assert.equal(isBuiltinProviderId('tokenharbor'), true);
    assert.equal(isBuiltinProviderId('river'), true);
  });
});

test('models are added per provider, the first becomes the default, and removal recomputes it', async () => {
  await withConfig(async ({ read }) => {
    await addExtraProvider({ name: 'myriver', baseURL: 'https://api.river.ai/v1', apiKey: 'rv-test' });
    const first = await addExtraProviderModel('myriver', 'deepseek-ai/DeepSeek-V4.1-Flash-1017');
    assert.equal(first.ok, true);
    assert.deepEqual(first.models, ['deepseek-ai/DeepSeek-V4.1-Flash-1017']);
    assert.equal((await read()).extraProviders[0].defaultModel, 'deepseek-ai/DeepSeek-V4.1-Flash-1017');

    const second = await addExtraProviderModel('myriver', 'zai-org/GLM-5.3-Flash');
    assert.equal(second.ok, true);
    assert.deepEqual(second.models, ['deepseek-ai/DeepSeek-V4.1-Flash-1017', 'zai-org/GLM-5.3-Flash']);
    assert.equal((await read()).extraProviders[0].defaultModel, 'deepseek-ai/DeepSeek-V4.1-Flash-1017');

    assert.equal((await addExtraProviderModel('myriver', 'zai-org/GLM-5.3-Flash')).reason, 'exists');
    assert.equal((await addExtraProviderModel('myriver', 'bad model')).reason, 'invalid');
    assert.equal((await addExtraProviderModel('nope', 'some/model')).reason, 'missing');
    assert.equal((await addExtraProviderModel('nvidia', 'some/model')).reason, 'builtin');

    const removed = await removeExtraProviderModel('myriver', 'deepseek-ai/DeepSeek-V4.1-Flash-1017');
    assert.equal(removed.ok, true);
    assert.deepEqual(removed.models, ['zai-org/GLM-5.3-Flash']);
    assert.equal(removed.defaultModel, 'zai-org/GLM-5.3-Flash');
    assert.equal((await removeExtraProviderModel('myriver', 'not/there')).reason, 'absent');
  });
});

test('removing a provider deletes its key, model and definition, and refuses built-ins or the active one', async () => {
  await withConfig(async ({ read }) => {
    await addExtraProvider({ name: 'myriver', baseURL: 'https://api.river.ai/v1', apiKey: 'rv-test' });
    await addExtraProviderModel('myriver', 'deepseek-ai/DeepSeek-V4.1-Flash-1017');
    const settings = await readSettings();
    assert.equal(readExtraProviders(settings.data).length, 1);

    assert.equal((await removeExtraProvider('myriver', { active: true })).reason, 'active');
    assert.equal((await removeExtraProvider('nvidia')).reason, 'builtin');
    assert.equal((await removeExtraProvider('river')).reason, 'builtin');
    assert.equal((await removeExtraProvider('nope')).reason, 'missing');

    const removed = await removeExtraProvider('myriver');
    assert.equal(removed.ok, true);
    const saved = await read();
    assert.deepEqual(saved.extraProviders, []);
    assert.equal(saved.providers?.myriver, undefined);
    assert.equal(readExtraProviders(saved).length, 0);
  });
});
