import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../../src/agent/agent.js';
import { ApprovalManager } from '../../src/agent/approvals.js';
import { ProcessManager } from '../../src/services/processes.js';
import { SessionStore } from '../../src/services/sessions.js';
import { UndoManager } from '../../src/services/undo.js';
import { buildToolRegistry } from '../../src/tools/index.js';
import { createCommands, shellCommandFromLine } from '../../src/cli/commands.js';
import { runUserShell, sanitizedEnv } from '../../src/services/ushell.js';
import { createTestWorkspace, RecordingRenderer, ScriptedProvider, response, testConfig } from '../helpers.js';

class ShellRecorder extends RecordingRenderer {
  constructor() {
    super();
    this.shells = [];
  }

  lines(text) {
    this.record('lines', { text });
  }

  shellResult(payload) {
    this.shells.push(payload);
    this.record('shellResult', payload);
  }
}

async function makeCommands({ approvalPolicy = 'auto', agent = null } = {}) {
  const fixture = await createTestWorkspace();
  const config = testConfig(fixture.root, { approvalPolicy });
  const renderer = new ShellRecorder();
  const commands = createCommands({
    config,
    workspace: fixture.workspace,
    registry: { list: () => [], get: () => null },
    processes: { list: () => [], getOutput: () => null },
    sessionStore: { list: async () => [], load: async () => null },
    undo: { size: 0, entries: [], list: () => [] },
    renderer,
    provider: { config },
    interactive: true,
    getAgent: () => agent,
    getLastSummary: () => null,
    getActiveTask: () => null,
    confirmLocal: async () => false,
  });
  return { commands, renderer, config, fixture };
}

test('a line starting with "!" is a shell command, not a prompt', () => {
  assert.deepEqual(shellCommandFromLine('!git status'), { name: 'bash', args: 'git status', parts: ['git', 'status'] });
  assert.deepEqual(shellCommandFromLine('  ! ls -la  '), { name: 'bash', args: 'ls -la', parts: ['ls', '-la'] });
  assert.deepEqual(shellCommandFromLine('!'), { name: 'bash', args: '', parts: [] });
  assert.equal(shellCommandFromLine('run the tests'), null);
  assert.equal(shellCommandFromLine(''), null);
});

test('runUserShell captures stdout, stderr, exit code and duration', async () => {
  const result = await runUserShell({ command: "printf 'one\\ntwo\\n'; printf 'oops\\n' >&2; exit 3" });
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, 'one\ntwo\n');
  assert.equal(result.stderr, 'oops\n');
  assert.equal(result.error, null);
  assert.ok(result.durationMs >= 0);
  assert.equal(result.truncated, false);
});

test('runUserShell keeps the tail of an over-long capture and marks it truncated', async () => {
  const result = await runUserShell({ command: "printf 'aaaaaaaaaa\\nbbbbbbbbbb\\n'", maxBytes: 12 });
  assert.equal(result.truncated, true);
  assert.equal(result.stdout.endsWith('bbbbbbbbbb\n'), true, 'the newest output is what survives');
});

test('runUserShell strips credential-looking variables from the child environment', async () => {
  const result = await runUserShell({
    command: 'printf "%s|%s" "$DEMO_API_KEY" "$KEEP_ME"',
    env: { PATH: process.env.PATH, DEMO_API_KEY: 'super-secret', KEEP_ME: 'kept' },
  });
  assert.equal(result.stdout, '|kept');
  assert.equal(sanitizedEnv({ DEMO_API_KEY: 'x', KEEP_ME: 'y' }).KEEP_ME, 'y');
});

test('runUserShell kills the child when the command is cancelled', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const running = runUserShell({ command: 'node -e "setTimeout(() => {}, 5000)"', signal: controller.signal });
  setTimeout(() => controller.abort(), 120);
  const result = await running;
  assert.ok(Date.now() - started < 3000, 'the command does not run to completion');
  assert.notEqual(result.exitCode, 0);
});

test('/bash prints the full output and adds the command to the AI session', async () => {
  const recorded = [];
  const { commands, renderer, fixture } = await makeCommands({
    agent: { recordUserShell: (payload) => recorded.push(payload) },
  });
  try {
    await commands.execute(shellCommandFromLine('!printf "line1\\nline2\\nline3\\nline4\\nline5\\nline6\\nline7\\n"'));
    assert.equal(renderer.shells.length, 1);
    const shell = renderer.shells[0];
    assert.equal(shell.command, 'printf "line1\\nline2\\nline3\\nline4\\nline5\\nline6\\nline7\\n"');
    assert.equal(shell.exitCode, 0);
    assert.equal(shell.stdout.split('\n').filter(Boolean).length, 7, 'every line reaches the terminal');
    assert.equal(shell.stdout.includes('line1'), true, 'nothing is reduced to a preview');

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].command, shell.command);
    assert.match(recorded[0].stdout, /line7/);
    assert.equal(recorded[0].exitCode, 0);
    assert.equal(recorded[0].cwd, fixture.root);
  } finally {
    await fixture.cleanup();
  }
});

test('/bash with no command shows usage, and --read-only refuses it', async () => {
  const readOnly = await makeCommands({ approvalPolicy: 'read-only' });
  try {
    const messages = [];
    readOnly.renderer.warn = (message) => messages.push(message);
    readOnly.renderer.lines = (text) => messages.push(text);
    await readOnly.commands.execute(shellCommandFromLine('!echo nope'));
    assert.equal(readOnly.renderer.shells.length, 0, 'nothing is executed under read-only');
    assert.match(messages.join('\n'), /read-only/i);

    await readOnly.commands.execute({ name: 'bash', args: '', parts: [] });
    assert.match(messages.join('\n'), /Usage: \/bash/);
  } finally {
    await readOnly.fixture.cleanup();
  }
});

test('shell history reaches the model on the next task', async () => {
  const fixture = await createTestWorkspace();
  try {
    const processes = new ProcessManager({ workspace: fixture.workspace, defaultTimeoutMs: 5000 });
    const registry = buildToolRegistry({ workspace: fixture.workspace, config: fixture.config, processes });
    const provider = new ScriptedProvider([response({ content: 'understood' })]);
    const agent = new Agent({
      provider,
      registry,
      workspace: fixture.workspace,
      config: fixture.config,
      renderer: new RecordingRenderer(),
      approvals: new ApprovalManager({ policy: 'auto' }),
      sessionStore: new SessionStore({ dir: fixture.config.historyDir }),
      undo: new UndoManager({ workspace: fixture.workspace, dir: fixture.config.undoDir }),
      processes,
    });

    agent.recordUserShell({
      command: 'npm test',
      cwd: fixture.root,
      stdout: 'tests 3\npass 3\n',
      exitCode: 0,
      durationMs: 42,
    });
    assert.match(agent.getConversation()[0].content, /\[user shell\] \$ npm test/);

    await agent.run('what did I just run?');
    const messages = provider.calls[0].messages;
    const shellTurn = messages.find((message) => message.role === 'user' && /\[user shell\]/.test(message.content));
    assert.ok(shellTurn, 'the shell turn is part of the request');
    assert.match(shellTurn.content, /npm test/);
    assert.match(shellTurn.content, /pass 3/);
    assert.match(shellTurn.content, /exit 0/);
    assert.equal(agent.getWorklog().commands.at(-1).status, 'user', 'the worklog records it as a user command');
    await processes.stopAll();
  } finally {
    await fixture.cleanup();
  }
});
