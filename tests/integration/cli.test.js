import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = path.join(ROOT, 'src', 'index.js');

function isolatedDir(prefix = 'ryuu-settings-integration-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const withKey = (provider = 'nvidia', apiKey = 'nvapi-test-key-123456') => ({
  version: 1,
  providers: { [provider]: { apiKey } },
});

/**
 * Run the CLI against an isolated config directory. Configuration is passed as
 * a config.json document; the environment only carries RYUU_CONFIG_DIR.
 */
function runCli(args, { settings = null, input = '', configDir = null } = {}) {
  const dir = configDir || isolatedDir('ryuu-cli-config-');
  if (settings) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(settings), 'utf8');
  const result = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    timeout: 60000,
    env: { ...process.env, RYUU_CONFIG_DIR: dir },
  });
  if (!configDir) fs.rmSync(dir, { recursive: true, force: true });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, dir };
}

test('--help prints usage and exits 0', () => {
  const result = runCli(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Ryuu Agent CLI/);
  assert.match(result.stdout, /--doctor/);
  assert.match(result.stdout, /--provider <id>/);
  assert.match(result.stdout, /config\.json/);
  assert.match(result.stdout, /ryuu --settings/);
  assert.ok(!result.stdout.includes('--env-file'), 'no environment file flag is advertised');
});

test('--provider tokenharbor without its key fails with the setting path', () => {
  const result = runCli(['--provider', 'tokenharbor', 'say hello'], { settings: withKey() });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Provider tokenharbor has no API key/);
  assert.match(result.stderr, /providers\.tokenharbor\.apiKey/);
  assert.match(result.stderr, /CONFIG_INVALID/);
});

test('--version prints the package version', () => {
  const result = runCli(['--version']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^ryuu-agent-cli \d+\.\d+\.\d+/);
});

test('unknown options fail clearly', () => {
  const result = runCli(['--bogus']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown option: --bogus/);
});

test('environment variables no longer configure anything', () => {
  const dir = isolatedDir('ryuu-cli-env-');
  try {
    const result = runCli(['--doctor'], { configDir: dir });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /providers\.nvidia\.apiKey is missing/, 'env keys are ignored');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--doctor without a key reports a blocking issue but stays helpful', () => {
  const result = runCli(['--doctor']);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /\[FAIL\] config: providers\.nvidia\.apiKey is missing/);
  assert.match(result.stdout, /Result: blocking issues found/);
  assert.equal(result.stderr.trim(), '');
});

test('starting without a key fails safely with setup instructions', () => {
  const result = runCli(['list the files']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Provider nvidia has no API key/);
  assert.match(result.stderr, /ryuu --settings/);
  assert.match(result.stderr, /CONFIG_INVALID/);
  assert.ok(!result.stderr.includes('at Object.'));
});

test('invalid numeric configuration is rejected before any API call', () => {
  const result = runCli(['task'], { settings: { ...withKey(), agent: { maxSteps: 'abc' } } });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /maxSteps must be an integer/);
});

test('non-interactive mode without a task exits with usage', () => {
  const result = runCli([], { input: '', settings: withKey() });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /No task provided in non-interactive mode/);
});

test('--auto-approve is a documented flag and parses without an unknown-option error', () => {
  const help = runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--auto-approve\s+Auto-approve ALL actions incl\. commands/);

  const result = runCli(['--auto-approve', 'do the thing'], { input: '', settings: withKey() });
  assert.notEqual(result.code, 2);
  assert.ok(!result.stderr.includes('Unknown option'));
});

test('a first run creates config.json with every key present and empty', () => {
  const dir = isolatedDir('ryuu-cli-first-run-');
  try {
    const result = runCli(['--doctor'], { configDir: dir });
    assert.equal(result.code, 1, 'no key is configured yet');
    assert.match(result.stdout, /providers\.nvidia\.apiKey is missing/);
    const file = path.join(dir, 'config.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.version, 1);
    assert.equal(saved.providers.nvidia.apiKey, '');
    assert.equal(saved.providerModel.nvidia, '');
    assert.equal(saved.agent.requestTimeoutMs, '');
    assert.equal(saved.webSearch.enabled, '');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--doctor with a fake key runs offline checks without printing the key', () => {
  const key = 'nvapi-test-key-doctor-123456';
  const result = runCli(['--doctor'], { settings: withKey('nvidia', key) });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /\[PASS\] config/);
  assert.match(result.stdout, /Offline check only/);
  assert.ok(!result.stdout.includes(key));
});

test('--settings --list prints the numbered settings without starting the agent', () => {
  const dir = isolatedDir();
  try {
    const result = runCli(['--settings', '--list'], { configDir: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /◇ Ryuu Settings/);
    assert.match(result.stdout, /provider/);
    assert.match(result.stdout, /providers\.nvidia\.apiKey/);
    assert.match(result.stdout, /\/exit/);
    assert.ok(!result.stdout.includes('RYUU // AGENT OS'), 'no banner: the agent never starts');
    assert.ok(!fs.existsSync(path.join(dir, 'config.json')), 'listing does not create a file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--settings --list accepts the flags in any order', () => {
  for (const args of [
    ['--list', '--settings'],
    ['--tui', '--settings', '--list'],
  ]) {
    const result = runCli(args);
    assert.equal(result.code, 0, args.join(' '));
    assert.match(result.stdout, /providers\.nvidia\.apiKey/);
  }
});

test('--settings --help shows the editor commands and writes nothing', () => {
  const dir = isolatedDir();
  try {
    const result = runCli(['--settings', '--help'], { configDir: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Editor commands/);
    assert.match(result.stdout, /\/reset <number>/);
    assert.equal(fs.readdirSync(dir).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--settings without a terminal fails gracefully and initializes a private file', () => {
  const dir = isolatedDir();
  try {
    const result = runCli(['--settings'], { input: '', configDir: dir });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /interactive terminal/);
    const file = path.join(dir, 'config.json');
    assert.ok(fs.existsSync(file), 'the missing settings file is initialized');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.version, 1);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--settings --tui without a terminal says so instead of hanging', () => {
  const result = runCli(['--settings', '--tui'], { input: '' });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--settings --tui needs an interactive terminal/);
  assert.match(result.stderr, /interactive terminal/);
});

test('--list without --settings keeps the established error behaviour', () => {
  const result = runCli(['--list']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--list is only valid with --settings/);
});

test('provider credentials in the settings file are used without printing them', () => {
  const dir = isolatedDir();
  const workspace = isolatedDir();
  const key = 'nvapi-settings-integration-key-123456';
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ version: 1, provider: 'nvidia', providers: { nvidia: { apiKey: key } } }),
    'utf8',
  );
  try {
    const result = runCli(['--doctor'], { configDir: dir });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /\[PASS\] config/);
    assert.ok(!result.stdout.includes(key), 'the key must never be printed');
    assert.ok(!result.stderr.includes(key));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('a malformed settings file is reported and left untouched', () => {
  const dir = isolatedDir();
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '{ "providers": oops', 'utf8');
    const before = fs.readFileSync(file, 'utf8');
    const result = runCli(['--settings', '--list'], { configDir: dir });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /not valid JSON/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
