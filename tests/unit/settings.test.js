import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  SettingsStore,
  applySettingsToRaw,
  getSetting,
  maskSettingsSecret,
  readSettings,
  setSetting,
  settingsDir,
  settingsModelFor,
  settingsProviderId,
  writeSettings,
} from '../../src/config/settings.js';
import { parseArgs } from '../../src/index.js';
import { buildSettingsRegistry } from '../../src/config/settings-registry.js';
import { buildProviders, parseExtraProviders } from '../../src/providers/catalog.js';
import { makeTempDir } from '../helpers.js';

test('the settings directory follows platform conventions and the env override', () => {
  assert.equal(
    settingsDir({ env: { XDG_CONFIG_HOME: '/xdg' }, home: '/home/u', platform: 'linux' }),
    path.join('/xdg', 'ryuu'),
  );
  assert.equal(
    settingsDir({ env: {}, home: '/home/u', platform: 'linux' }),
    path.join('/home/u', '.config', 'ryuu'),
  );
  assert.equal(
    settingsDir({ env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, home: '/home/u', platform: 'win32' }),
    path.join('C:\\Users\\u\\AppData\\Roaming', 'ryuu'),
  );
  assert.equal(
    settingsDir({ env: {}, home: '/Users/u', platform: 'darwin' }),
    path.join('/Users/u', 'Library', 'Application Support', 'ryuu'),
  );
  assert.equal(
    settingsDir({ env: { RYUU_CONFIG_DIR: '/custom/dir' }, home: '/home/u', platform: 'linux' }),
    '/custom/dir',
  );
});

test('a missing settings file reports defaults and is not created by reading', async () => {
  const dir = await makeTempDir('ryuu-settings-');
  const file = path.join(dir, 'config.json');
  const result = await readSettings({ file });
  assert.equal(result.exists, false);
  assert.deepEqual(result.data, { version: 1 });
  assert.equal(await fsp.stat(file).catch(() => null), null);
});

test('writing creates the directory and a file only the owner can read', async () => {
  const root = await makeTempDir('ryuu-settings-');
  const file = path.join(root, 'nested', 'ryuu', 'config.json');
  await writeSettings({ version: 1, provider: 'nvidia' }, { file });
  const saved = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.equal(saved.provider, 'nvidia');
  if (process.platform !== 'win32') {
    const stats = await fsp.stat(file);
    assert.equal(stats.mode & 0o777, 0o600, 'credentials must be owner-only');
  }
});

test('one-key updates preserve every other key, including unknown ones', async () => {
  const root = await makeTempDir('ryuu-settings-');
  const file = path.join(root, 'config.json');
  await writeSettings(
    {
      version: 1,
      provider: 'nvidia',
      somethingUnknown: { keep: true },
      providers: { nvidia: { apiKey: 'nvapi-keep-me' } },
      agent: { maxSteps: 3 },
    },
    { file },
  );
  const store = new SettingsStore({ file });
  const saved = await store.update((draft) => {
    setSetting(draft, 'agent.maxSteps', 4);
    return draft;
  });
  assert.equal(getSetting(saved, 'agent.maxSteps'), 4);
  assert.equal(getSetting(saved, 'providers.nvidia.apiKey'), 'nvapi-keep-me');
  assert.deepEqual(saved.somethingUnknown, { keep: true });
});

test('a malformed settings file is reported and never overwritten', async () => {
  const root = await makeTempDir('ryuu-settings-');
  const file = path.join(root, 'config.json');
  await fsp.writeFile(file, '{ "providers": ', 'utf8');
  await assert.rejects(() => readSettings({ file }), /not valid JSON/);
  const store = new SettingsStore({ file });
  await assert.rejects(
    () => store.update((draft) => setSetting(draft, 'agent.maxSteps', 9)),
    /not valid JSON/,
  );
  assert.equal(await fsp.readFile(file, 'utf8'), '{ "providers": ', 'the broken file is untouched');
});

test('a settings path that is a symlink is refused', async () => {
  if (process.platform === 'win32') return;
  const root = await makeTempDir('ryuu-settings-');
  const real = path.join(root, 'real.json');
  const link = path.join(root, 'config.json');
  await fsp.writeFile(real, '{}', 'utf8');
  await fsp.symlink(real, link);
  await assert.rejects(() => readSettings({ file: link }), /symlink/);
});

test('settings are found from any working directory', async () => {
  const root = await makeTempDir('ryuu-settings-');
  const other = await makeTempDir('ryuu-cwd-');
  const previous = process.cwd();
  try {
    process.chdir(other);
    const result = await readSettings({ env: { RYUU_CONFIG_DIR: root }, home: other });
    assert.equal(result.file, path.join(root, 'config.json'));
  } finally {
    process.chdir(previous);
  }
});

test('env wins over the file, and the file fills only what env left empty', () => {
  const env = { NVIDIA_API_KEY: 'nvapi-from-env' };
  const raw = {
    providerEnv: env,
    maxSteps: '',
    maxOutputTokens: 1234,
    webSearchApiKey: '',
    webSearchResults: '',
  };
  applySettingsToRaw(raw, {
    providers: {
      nvidia: { apiKey: 'nvapi-from-file', baseURL: 'https://proxy.invalid/v1' },
      tokenharbor: { apiKey: 'th-from-file' },
    },
    agent: { maxSteps: 12, maxOutputTokens: 99, approvalPolicy: 'auto' },
    webSearch: { serperApiKey: 'serper-from-file', results: 7, providers: ['you', 'tavily'] },
  });
  assert.equal(raw.providerEnv.NVIDIA_API_KEY, 'nvapi-from-env', 'the environment keeps precedence');
  assert.equal(raw.providerEnv.NVIDIA_BASE_URL, 'https://proxy.invalid/v1', 'empty env is filled from the file');
  assert.equal(raw.providerEnv.TOKENHARBOR_API_KEY, 'th-from-file');
  assert.equal(raw.maxSteps, 12);
  assert.equal(raw.maxOutputTokens, 1234, 'an env value is never replaced');
  assert.equal(raw.approvalPolicy, 'auto');
  assert.equal(raw.webSearchApiKey, 'serper-from-file');
  assert.equal(raw.webSearchResults, 7);
  assert.equal(raw.webSearchProviders, 'you,tavily');
  assert.notEqual(raw.providerEnv, env, 'process.env must never be mutated');
});

test('provider and model helpers normalize hand-edited values', () => {
  assert.equal(settingsProviderId({ provider: 'TokenHarbor' }), 'tokenharbor');
  assert.equal(settingsProviderId({ provider: 'not a provider!' }), null);
  assert.equal(settingsModelFor({ providerModel: { tokenharbor: 'deepseek-v4.1-flash:free' } }, 'TOKENHARBOR'), 'deepseek-v4.1-flash:free');
  assert.equal(settingsModelFor({ providerModel: { tokenharbor: 'bad id' } }, 'tokenharbor'), null);
});

test('the CLI parses the settings flags in any order', () => {
  assert.equal(parseArgs(['--settings']).settings, true);
  assert.equal(parseArgs([]).settings, false);
  const options = parseArgs(['--tui', '--settings', '--list']);
  assert.equal(options.settings, true);
  assert.equal(options.list, true);
  assert.equal(options.tui, true);
  assert.equal(parseArgs(['--list', '--settings']).settings, true);
});

test('extra RYUU_PROVIDERS entries get their own key, URL and model settings', () => {
  const extras = parseExtraProviders(
    JSON.stringify([
      {
        id: 'myproxy',
        name: 'My Proxy',
        baseURL: 'https://proxy.invalid/v1',
        apiKeyEnv: 'MY_PROXY_KEY',
        models: ['model-a'],
      },
    ]),
    [],
  );
  const providers = buildProviders({ env: {}, extras });
  const entries = buildSettingsRegistry({ providers, settings: {}, env: {} });
  const key = entries.find((entry) => entry.key === 'providers.myproxy.apiKey');
  assert.equal(key.label, 'MY_PROXY_KEY');
  assert.equal(key.secret, true);
  assert.equal(entries.find((entry) => entry.key === 'providers.myproxy.baseURL').defaultValue, 'https://proxy.invalid/v1');
  const model = entries.find((entry) => entry.key === 'providerModel.myproxy');
  assert.ok(model.choices.includes('model-a'));
});

test('the registry validates values and flags environment overrides', () => {
  const providers = buildProviders({ env: {}, extras: [] });
  const entries = buildSettingsRegistry({ providers, settings: {}, env: { NVIDIA_API_KEY: 'nvapi-env' } });
  const key = entries.find((entry) => entry.label === 'NVIDIA_API_KEY');
  assert.equal(key.envOverride, true);
  assert.equal(key.validate('nvapi-abc123').ok, true);
  assert.equal(key.validate('has space').ok, false);
  assert.equal(key.validate('YOUR_API_KEY').ok, false, 'placeholders are rejected');
  assert.equal(key.validate('').ok, true, 'an empty key is allowed for an optional provider');

  const url = entries.find((entry) => entry.key === 'providers.nvidia.baseURL');
  assert.equal(url.validate('https://proxy.invalid/v1/').value, 'https://proxy.invalid/v1');
  assert.equal(url.validate('ftp://proxy.invalid').ok, false);
  assert.equal(url.validate('https://user:pass@proxy.invalid').ok, false, 'credentials in URLs are refused');

  const steps = entries.find((entry) => entry.label === 'AGENT_MAX_STEPS');
  assert.equal(steps.validate('12').value, 12);
  assert.equal(steps.validate('abc').ok, false);
  assert.equal(steps.validate('-1').ok, false);
});

test('a secret mask never reveals the value or its length', () => {
  assert.equal(maskSettingsSecret('nvapi-abcdef'), '••••••••');
  assert.equal(maskSettingsSecret('x'), '••••••••');
  assert.equal(maskSettingsSecret(''), '(not set)');
});
