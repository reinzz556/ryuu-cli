import test from 'node:test';
import assert from 'node:assert/strict';
import { ProcessManager, buildChildEnv } from '../../src/services/processes.js';
import { createTestWorkspace } from '../helpers.js';

async function makeManager(options = {}) {
  const fixture = await createTestWorkspace();
  const manager = new ProcessManager({
    workspace: fixture.workspace,
    maxBufferBytes: options.maxBufferBytes ?? 65536,
    defaultTimeoutMs: 5000,
    ...options,
  });
  return { fixture, manager };
}

test('captures real stdout, stderr, exit code and duration', async () => {
  const { fixture, manager } = await makeManager();
  try {
    const record = manager.start({
      argv: [process.execPath, '-e', "console.log('hello-out'); console.error('hello-err'); process.exit(3)"],
      timeoutMs: 10000,
    });
    await record.done;
    assert.equal(record.status, 'failed');
    assert.equal(record.exitCode, 3);
    assert.match(record.stdout.text, /hello-out/);
    assert.match(record.stderr.text, /hello-err/);
    assert.ok(record.durationMs >= 0);
    assert.ok(record.startedAtIso);
    assert.ok(record.endedAtIso);
  } finally {
    await manager.stopAll();
    await fixture.cleanup();
  }
});

test('successful command reports exited status', async () => {
  const { fixture, manager } = await makeManager();
  try {
    const record = manager.start({ argv: [process.execPath, '-e', "console.log('ok')"], timeoutMs: 10000 });
    await record.done;
    assert.equal(record.status, 'exited');
    assert.equal(record.exitCode, 0);
  } finally {
    await manager.stopAll();
    await fixture.cleanup();
  }
});

test('timeouts terminate the process and set timedOut', async () => {
  const { fixture, manager } = await makeManager();
  try {
    const record = manager.start({ argv: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'], timeoutMs: 300 });
    await record.done;
    assert.equal(record.timedOut, true);
    assert.equal(record.status, 'timeout');
    assert.equal(record.exitCode, null);
  } finally {
    await manager.stopAll();
    await fixture.cleanup();
  }
});

test('output buffers are bounded and truncation is reported', async () => {
  const { fixture, manager } = await makeManager({ maxBufferBytes: 400 });
  try {
    const record = manager.start({
      argv: [process.execPath, '-e', "console.log('x'.repeat(5000))"],
      timeoutMs: 10000,
    });
    await record.done;
    assert.equal(record.stdout.truncated, true);
    assert.ok(record.stdout.text.length <= 600);
    assert.match(record.stdout.text, /output truncated/);
  } finally {
    await manager.stopAll();
    await fixture.cleanup();
  }
});

test('stops long-running processes gracefully', async () => {
  const { fixture, manager } = await makeManager();
  try {
    const record = manager.start({ argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], timeoutMs: 0 });
    assert.equal(record.status, 'running');
    assert.ok(manager.list().some((proc) => proc.id === record.id && proc.status === 'running'));
    const result = await manager.stop(record.id, { graceMs: 300 });
    assert.equal(result.stopped, true);
    assert.ok(['killed', 'failed'].includes(result.status));
    assert.equal(record.status === 'running', false);
  } finally {
    await manager.stopAll();
    await fixture.cleanup();
  }
});

test('getOutput and get() expose process metadata', async () => {
  const { fixture, manager } = await makeManager();
  try {
    const record = manager.start({ argv: [process.execPath, '-e', "console.log('output-line')"], timeoutMs: 10000 });
    await record.done;
    const output = manager.getOutput(record.id, { tailBytes: 1000 });
    assert.match(output.stdout, /output-line/);
    assert.equal(output.exitCode, 0);
    assert.equal(manager.get(record.id).id, record.id);
    assert.throws(() => manager.get('p999'), /Unknown process id/);
  } finally {
    await manager.stopAll();
    await fixture.cleanup();
  }
});

test('rejects shell commands unless explicitly allowed', async () => {
  const { fixture, manager } = await makeManager();
  try {
    assert.throws(() => manager.start({ shellCommand: 'echo hi', timeoutMs: 1000 }), /Shell execution is disabled/);
  } finally {
    await manager.stopAll();
    await fixture.cleanup();
  }
});

test('rejects invalid argv and cwd escapes', async () => {
  const { fixture, manager } = await makeManager();
  try {
    assert.throws(() => manager.start({ argv: [], timeoutMs: 1000 }), /non-empty array/);
    assert.throws(() => manager.start({ argv: ['echo', 5], timeoutMs: 1000 }), /non-empty string/);
    assert.throws(() => manager.start({ argv: ['echo', 'hi'], cwd: '../outside', timeoutMs: 1000 }), (e) => e.code === 'PATH_ESCAPE');
    const missing = manager.start({ argv: ['definitely-not-a-binary-xyz'], timeoutMs: 1000 });
    await missing.done;
    assert.equal(missing.status, 'failed');
    assert.match(String(missing.error), /ENOENT/);
  } finally {
    await manager.stopAll();
    await fixture.cleanup();
  }
});

test('child process environment strips credential variables', () => {
  const env = buildChildEnv(
    { PATH: '/usr/bin', NVIDIA_API_KEY: 'nvapi-secret', GITHUB_TOKEN: 'x', SOME_PASSWORD: 'y', NORMAL_VALUE: 'ok' },
    { extra: { EXTRA: '1' } },
  );
  assert.equal(env.NVIDIA_API_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.SOME_PASSWORD, undefined);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.NORMAL_VALUE, 'ok');
  assert.equal(env.EXTRA, '1');
  assert.equal(env.RYUU_AGENT, '1');
});
