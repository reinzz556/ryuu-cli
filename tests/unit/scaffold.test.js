import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { buildSettingsSkeleton, ensureSettingsFile } from '../../src/config/scaffold.js';
import { buildRawConfig } from '../../src/config/load.js';
import { getSetting, readSettings } from '../../src/config/settings.js';
import { buildSettingsRegistry } from '../../src/config/settings-registry.js';
import { buildProviders, parseExtraProviders } from '../../src/providers/catalog.js';
import { validateConfig } from '../../src/config/validate.js';
import { makeTempDir } from '../helpers.js';

test('the scaffold lists every editable setting with an empty value', () => {
  const skeleton = buildSettingsSkeleton();
  const raw = buildRawConfig(skeleton);
  const registry = buildSettingsRegistry({
    providers: buildProviders({ extras: parseExtraProviders(raw.extraProviders, []) }),
    settings: skeleton,
  });
  for (const entry of registry) {
    const value = getSetting(skeleton, entry.key);
    assert.notEqual(value, undefined, `${entry.key} is missing from the scaffold`);
    assert.equal(value, '', `${entry.key} starts empty`);
  }
  assert.deepEqual(skeleton.extraProviders, []);
});

test('an empty scaffold validates as the built-in defaults', () => {
  const raw = buildRawConfig(buildSettingsSkeleton(), { cwd: process.cwd() });
  const { config, warnings } = validateConfig(raw, { requireApiKey: false, cwd: process.cwd() });
  assert.equal(config.providerId, 'nvidia');
  assert.equal(config.model, 'minimaxai/minimax-m3.1-flash');
  assert.equal(config.requestTimeoutMs, 120000);
  assert.equal(config.maxTaskDurationMs, 900000);
  assert.equal(config.webSearchEnabled, true, 'an empty value must not disable web search');
  assert.equal(config.allowShell, false);
  assert.deepEqual(warnings, []);
});

test('a missing file is created once, owner-only, and never rewritten afterwards', async () => {
  const dir = await makeTempDir('ryuu-scaffold-');
  const file = path.join(dir, 'nested', 'config.json');
  const first = await ensureSettingsFile({ file });
  assert.equal(first.created, true);
  assert.equal(first.exists, true);
  if (process.platform !== 'win32') {
    assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
  }

  await fsp.writeFile(file, JSON.stringify({ version: 1, agent: { maxSteps: 7 } }), 'utf8');
  const second = await ensureSettingsFile({ file });
  assert.equal(second.created, false);
  assert.equal(second.data.agent.maxSteps, 7);
  assert.equal((await readSettings({ file })).data.agent.maxSteps, 7, 'the existing file is untouched');
});

test('a malformed file is reported instead of being replaced by the scaffold', async () => {
  const dir = await makeTempDir('ryuu-scaffold-');
  const file = path.join(dir, 'config.json');
  await fsp.writeFile(file, '{ broken', 'utf8');
  await assert.rejects(() => ensureSettingsFile({ file }), /not valid JSON/);
  assert.equal(await fsp.readFile(file, 'utf8'), '{ broken');
});
