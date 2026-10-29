import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { SettingsStore } from '../../src/config/settings.js';
import { buildSettingsRegistry } from '../../src/config/settings-registry.js';
import { SettingsSession } from '../../src/cli/settings-editor.js';
import { buildProviders } from '../../src/providers/catalog.js';
import { makeTempDir } from '../helpers.js';

async function makeSession(initial = {}) {
  const dir = await makeTempDir('ryuu-settings-editor-');
  const file = path.join(dir, 'config.json');
  const store = new SettingsStore({ file });
  await store.save({ version: 1, ...initial });
  const { data } = await store.read();
  const providers = buildProviders({ credentials: {}, extras: [] });
  const makeRegistry = (current) => buildSettingsRegistry({ providers, settings: current });
  const session = new SettingsSession({ store, makeRegistry, data, file });
  return { dir, file, store, session, makeRegistry };
}

function numberOf(session, label) {
  const index = session.entries.findIndex((entry) => entry.label === label);
  assert.ok(index >= 0, `setting ${label} must be listed`);
  return index + 1;
}

test('the list masks secrets and shows the current provider settings', async () => {
  const { session } = await makeSession({
    providers: { nvidia: { apiKey: 'nvapi-super-secret-value' } },
    agent: { maxSteps: 9 },
  });
  const text = session.listLines().join('\n');
  assert.match(text, /provider/);
  assert.match(text, /providers\.nvidia\.apiKey\s+••••••••/);
  assert.ok(!text.includes('nvapi-super-secret-value'), 'the key must never be printed');
  assert.match(text, /agent\.maxSteps\s+9/);
  assert.match(text, /\/exit/);
});

test('a numbered assignment saves only that key and confirms without the secret', async () => {
  const { session, file } = await makeSession();
  const number = numberOf(session, 'providers.nvidia.apiKey');
  const result = await session.handleLine(`${number} nvapi-new-key-123456`);
  assert.equal(result.exit, false);
  assert.match(result.lines[0], /Saved providers\.nvidia\.apiKey/);
  assert.ok(!result.lines[0].includes('nvapi-new-key-123456'), 'the confirmation must not echo the secret');
  const saved = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.equal(saved.providers.nvidia.apiKey, 'nvapi-new-key-123456');
});

test('a value containing spaces is kept whole', async () => {
  const { session, file } = await makeSession();
  const number = numberOf(session, 'webSearch.providers');
  const result = await session.handleLine(`${number} you, firecrawl,  tavily`);
  assert.match(result.lines[0], /Saved webSearch.providers = you, firecrawl, tavily/);
  const saved = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.deepEqual(saved.webSearch.providers, ['you', 'firecrawl', 'tavily']);
});

test('invalid indexes and invalid values are rejected without touching the file', async () => {
  const { session, file } = await makeSession({ agent: { maxSteps: 4 } });
  const before = await fsp.readFile(file, 'utf8');

  const missing = await session.handleLine('999 anything');
  assert.match(missing.lines[0], /Unknown setting/);

  const badFormat = await session.handleLine('not a number');
  assert.match(badFormat.lines[0], /Format: <number> <value>/);

  const noValue = await session.handleLine(String(numberOf(session, 'agent.maxSteps')));
  assert.match(noValue.lines[0], /Enter a value/);

  const tooBig = await session.handleLine(`${numberOf(session, 'agent.maxSteps')} 999999`);
  assert.match(tooBig.lines[0], /between 0 and 100000/);

  const badModel = await session.handleLine(`${numberOf(session, 'providerModel.nvidia')} not a model; rm -rf`);
  assert.match(badModel.lines[0], /unsupported characters/);

  assert.equal(await fsp.readFile(file, 'utf8'), before, 'the last valid configuration survives');
  assert.equal(session.entries.find((entry) => entry.label === 'agent.maxSteps').value, 4);
});

test('/help, /list, /show and /exit behave as documented', async () => {
  const { session } = await makeSession({ providers: { nvidia: { apiKey: 'nvapi-show-secret' } } });
  const help = await session.handleLine('/help');
  assert.ok(help.lines.some((line) => line.includes('/reset <number>')));
  assert.equal(help.exit, false);

  const list = await session.handleLine('/list');
  assert.ok(list.lines.some((line) => line.includes('providers.nvidia.apiKey')));

  const show = await session.handleLine(`/show ${numberOf(session, 'providers.nvidia.apiKey')}`);
  const shown = show.lines.join('\n');
  assert.match(shown, /value: ••••••••/);
  assert.ok(!shown.includes('nvapi-show-secret'), 'the stored key is never revealed');

  const unknown = await session.handleLine('/bogus');
  assert.match(unknown.lines[0], /Unknown command/);

  const exit = await session.handleLine('/exit');
  assert.equal(exit.exit, true);
});

test('reset asks for confirmation and only then restores the default', async () => {
  const { session, file } = await makeSession({ agent: { maxSteps: 33 } });
  const number = numberOf(session, 'agent.maxSteps');

  let asked = '';
  const denied = await session.handleLine(`/reset ${number}`, {
    confirm: async (question) => {
      asked = question;
      return false;
    },
  });
  assert.match(asked, /Reset agent\.maxSteps/);
  assert.match(denied.lines[0], /cancelled/);
  assert.equal(JSON.parse(await fsp.readFile(file, 'utf8')).agent.maxSteps, 33);

  const accepted = await session.handleLine(`/reset ${number}`, { confirm: async () => true });
  assert.match(accepted.lines[0], /Saved agent\.maxSteps/);
  assert.equal(JSON.parse(await fsp.readFile(file, 'utf8')).agent.maxSteps, 0);
});

test('a failed write is reported and never shown as saved', async () => {
  const { session } = await makeSession({ agent: { maxSteps: 2 } });
  session.store.update = async () => {
    throw new Error('disk full');
  };
  const result = await session.handleLine(`${numberOf(session, 'agent.maxSteps')} 5`);
  assert.match(result.lines[0], /was NOT saved/);
  assert.match(result.lines[0], /disk full/);
  assert.equal(session.entries.find((entry) => entry.label === 'agent.maxSteps').value, 2);
});
