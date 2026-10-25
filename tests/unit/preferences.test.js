import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  addCustomModel,
  applyPersistedModel,
  preferencesFile,
  readCustomModels,
  readModelPreference,
  removeCustomModel,
  stateDirFor,
  writeModelPreference,
} from '../../src/services/preferences.js';
import { makeTempDir } from '../helpers.js';

test('a model choice round-trips through the preferences file', async () => {
  const dir = stateDirFor(await makeTempDir('ryuu-prefs-'));
  assert.equal(await readModelPreference(dir), null, 'no file yet');

  assert.equal(await writeModelPreference(dir, 'z-ai/glm-5.3-flash'), true);
  assert.equal(await readModelPreference(dir), 'z-ai/glm-5.3-flash');
  const saved = JSON.parse(await fsp.readFile(preferencesFile(dir), 'utf8'));
  assert.equal(saved.model, 'z-ai/glm-5.3-flash');
  assert.ok(saved.updatedAt, 'the file records when the choice was made');
});

test('corrupt or invalid preference files are ignored, never thrown', async () => {
  const dir = stateDirFor(await makeTempDir('ryuu-prefs-'));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(preferencesFile(dir), '{ not json', 'utf8');
  assert.equal(await readModelPreference(dir), null);

  await fsp.writeFile(preferencesFile(dir), JSON.stringify({ model: 42 }), 'utf8');
  assert.equal(await readModelPreference(dir), null);

  await fsp.writeFile(preferencesFile(dir), JSON.stringify({ model: 'bad id; rm -rf' }), 'utf8');
  assert.equal(await readModelPreference(dir), null, 'ids with unsafe characters are rejected');

  assert.equal(await writeModelPreference(dir, 'also bad; id'), false, 'invalid ids are not persisted');
});

test('added models and the selected model share the file without clobbering each other', async () => {
  const dir = stateDirFor(await makeTempDir('ryuu-prefs-'));
  assert.deepEqual(await readCustomModels(dir), []);

  assert.equal((await addCustomModel(dir, 'meta-llama/llama-3.3-70b-instruct')).ok, true);
  assert.equal((await addCustomModel(dir, '  mistralai/mistral-large  ')).ok, true);
  assert.deepEqual(await readCustomModels(dir), [
    'meta-llama/llama-3.3-70b-instruct',
    'mistralai/mistral-large',
  ]);

  await writeModelPreference(dir, 'mistralai/mistral-large');
  assert.deepEqual(
    await readCustomModels(dir),
    ['meta-llama/llama-3.3-70b-instruct', 'mistralai/mistral-large'],
    'switching model keeps the added list',
  );

  assert.equal((await removeCustomModel(dir, 'meta-llama/llama-3.3-70b-instruct')).ok, true);
  assert.deepEqual(await readCustomModels(dir), ['mistralai/mistral-large']);
  assert.equal(
    await readModelPreference(dir),
    'mistralai/mistral-large',
    'removing a model keeps the selected one',
  );
});

test('addCustomModel rejects duplicates and unusable ids; removeCustomModel rejects unknown ids', async () => {
  const dir = stateDirFor(await makeTempDir('ryuu-prefs-'));
  await addCustomModel(dir, 'a/b');
  assert.equal((await addCustomModel(dir, 'a/b')).reason, 'exists');
  assert.equal((await addCustomModel(dir, 'bad id')).reason, 'invalid');
  assert.equal((await addCustomModel(dir, '   ')).reason, 'invalid');
  assert.equal((await addCustomModel(dir, 42)).reason, 'invalid');
  assert.deepEqual(await readCustomModels(dir), ['a/b']);
  assert.equal((await removeCustomModel(dir, 'nope/nope')).reason, 'missing');
  assert.equal((await removeCustomModel(dir, 'a/b')).ok, true);
  assert.deepEqual(await readCustomModels(dir), []);
});

test('corrupt model list entries are skipped instead of breaking the list', async () => {
  const dir = stateDirFor(await makeTempDir('ryuu-prefs-'));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    preferencesFile(dir),
    JSON.stringify({ model: 'ok/model', models: ['ok/model', 7, 'bad id', 'ok/model', null] }),
    'utf8',
  );
  assert.deepEqual(await readCustomModels(dir), ['ok/model']);
  assert.equal(await readModelPreference(dir), 'ok/model');
});

test('applyPersistedModel: persisted choice beats env, flag beats everything', async () => {
  const dir = stateDirFor(await makeTempDir('ryuu-prefs-'));

  const raw = { model: 'env/model' };
  assert.equal(await applyPersistedModel(raw, { stateDir: dir }), false, 'no file is a no-op');
  assert.equal(raw.model, 'env/model');

  await writeModelPreference(dir, 'stepfun-ai/step-5-preview');
  assert.equal(await applyPersistedModel(raw, { stateDir: dir }), true);
  assert.equal(raw.model, 'stepfun-ai/step-5-preview', 'the saved choice wins over NVIDIA_MODEL');

  const flagged = { model: 'env/model' };
  assert.equal(
    await applyPersistedModel(flagged, { flagModel: 'cli/flag-model', stateDir: dir }),
    false,
    'an explicit --model flag wins for this run only',
  );
  assert.equal(flagged.model, 'env/model');
  assert.equal(await readModelPreference(dir), 'stepfun-ai/step-5-preview', 'the flag never rewrites the saved choice');
});
