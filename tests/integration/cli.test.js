import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = path.join(ROOT, 'src', 'index.js');

function runCli(args, { env = {}, input = '' } = {}) {
  const result = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    timeout: 60000,
    env: {
      ...process.env,
      NVIDIA_API_KEY: '',
      AGENT_WORKSPACE: '',
      ...env,
    },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('--help prints usage and exits 0', () => {
  const result = runCli(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Ryuu Agent CLI/);
  assert.match(result.stdout, /--doctor/);
  assert.match(result.stdout, /--provider <id>/);
  assert.match(result.stdout, /NVIDIA_API_KEY/);
  assert.match(result.stdout, /TOKENHARBOR_API_KEY/);
});

test('--provider tokenharbor without its key fails with the variable name', () => {
  const result = runCli(['--provider', 'tokenharbor', 'say hello'], {
    env: { NVIDIA_API_KEY: 'nvapi-test-key-123456', TOKENHARBOR_API_KEY: '' },
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /TOKENHARBOR_API_KEY is not set for provider tokenharbor/);
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

test('--doctor without a key reports a blocking issue but stays helpful', () => {
  const result = runCli(['--doctor']);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /\[FAIL\] config: NVIDIA_API_KEY is missing/);
  assert.match(result.stdout, /Result: blocking issues found/);
  assert.equal(result.stderr.trim(), '');
});

test('starting without a key fails safely with setup instructions', () => {
  const result = runCli(['list the files']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /NVIDIA_API_KEY is not set/);
  assert.match(result.stderr, /\.env\.example/);
  assert.match(result.stderr, /CONFIG_INVALID/);
  assert.ok(!result.stderr.includes('at Object.'));
});

test('invalid numeric configuration is rejected before any API call', () => {
  const result = runCli(['task'], { env: { NVIDIA_API_KEY: 'nvapi-test-key-123456', AGENT_MAX_STEPS: 'abc' } });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /maxSteps must be an integer/);
});

test('non-interactive mode without a task exits with usage', () => {
  const result = runCli([], { input: '', env: { NVIDIA_API_KEY: 'nvapi-test-key-123456' } });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /No task provided in non-interactive mode/);
});

test('--auto-approve is a documented flag and parses without an unknown-option error', () => {
  const help = runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--auto-approve\s+Auto-approve ALL actions incl\. commands/);

  const result = runCli(['--auto-approve', 'do the thing'], {
    input: '',
    env: { NVIDIA_API_KEY: 'nvapi-test-key-123456' },
  });
  assert.notEqual(result.code, 2);
  assert.ok(!result.stderr.includes('Unknown option'));
});

test('--doctor with a fake key runs offline checks without printing the key', () => {
  const key = 'nvapi-test-key-doctor-123456';
  const result = runCli(['--doctor'], { env: { NVIDIA_API_KEY: key } });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /\[PASS\] config/);
  assert.match(result.stdout, /Offline check only/);
  assert.ok(!result.stdout.includes(key));
});
