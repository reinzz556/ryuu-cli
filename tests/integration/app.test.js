import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { collectTask, createApp } from '../../src/cli/app.js';
import { createTestWorkspace, ScriptedProvider, response, testConfig, toolCall } from '../helpers.js';

function captureStream() {
  let data = '';
  const stream = new Writable({
    write(chunk, encoding, callback) {
      data += chunk.toString();
      callback();
    },
  });
  stream.isTTY = false;
  stream.getData = () => data;
  stream.reset = () => { data = ''; };
  return stream;
}

function ttyCapture() {
  let data = '';
  const stream = new Writable({
    write(chunk, encoding, callback) {
      data += chunk.toString();
      callback();
    },
  });
  stream.isTTY = true;
  stream.columns = 80;
  stream.rows = 40;
  stream.getData = () => data;
  stream.reset = () => {
    data = '';
  };
  return stream;
}

function ttyInput() {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.setRawMode = () => stream;
  return stream;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeInput() {
  const stream = new Writable({
    write(chunk, encoding, callback) {
      callback();
    },
  });
  stream.isTTY = false;
  return stream;
}

async function setup({ responses, configOverrides = {}, policy = 'auto' }) {
  const fixture = await createTestWorkspace();
  const config = testConfig(fixture.root, { approvalPolicy: policy, ...configOverrides });
  const provider = new ScriptedProvider(responses);
  const stdout = captureStream();
  const stderr = captureStream();
  const app = await createApp({
    config,
    cliOptions: { interactive: false, plain: true },
    stdout,
    stderr,
    input: fakeInput(),
    provider,
    version: '0.1.0',
  });
  return {
    fixture,
    config,
    provider,
    stdout,
    stderr,
    app,
    async cleanup() {
      await app.close();
      await fixture.cleanup();
    },
  };
}

test('a task is sent on a single Enter, with opt-in continuation lines', async () => {
  // The old prompt waited for a second (empty) Enter, so a normal one-line
  // task sat on a bare `>` prompt and the CLI looked dead.
  const asked = [];
  const ask = async (question) => {
    asked.push(question);
    return 'baris kedua';
  };
  assert.equal(await collectTask({ firstLine: 'perbaiki bug renderer', ask }), 'perbaiki bug renderer');
  assert.deepEqual(asked, [], 'a plain task must not ask for another line');

  let continued = 0;
  const multiline = await collectTask({
    firstLine: 'baris pertama \\',
    ask,
    onContinue: () => { continued += 1; },
  });
  assert.equal(multiline, 'baris pertama\nbaris kedua');
  assert.equal(continued, 1, 'the continuation hint is shown once per joined line');
  assert.match(asked[0], /↳/);

  assert.equal(await collectTask({ firstLine: 'x \\', ask: async () => null }), null, 'Ctrl+C while composing cancels the task');
});

test('banner shows model/workspace but never the API key', async () => {
  const ctx = await setup({ responses: [] });
  try {
    ctx.app.banner();
    const output = ctx.stdout.getData();
    assert.match(output, /Ryuu Agent CLI v0\.1\.0/);
    assert.match(output, /test\/model/);
    assert.match(output, new RegExp(ctx.config.workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(!output.includes('nvapi-test-key-123456'));
  } finally {
    await ctx.cleanup();
  }
});

test('runs a complete task through the wired app and persists a redacted session', async () => {
  const ctx = await setup({
    responses: [
      response({ content: '1. Inspect files\n2. Create a report\n3. Confirm', toolCalls: [toolCall('list_files', { path: '.' })] }),
      response({ toolCalls: [toolCall('write_file', { path: 'REPORT.md', content: '# Report\n\nAll good.\n' })] }),
      response({ content: 'Created REPORT.md after inspecting the workspace.' }),
    ],
  });
  try {
    const summary = await ctx.app.runTask('create a report');
    assert.equal(summary.status, 'completed');
    assert.deepEqual(summary.changedFiles, ['REPORT.md']);
    assert.ok(summary.plan.includes('Inspect files'));
    assert.equal(await ctx.fixture.workspace.exists('REPORT.md'), true);
    assert.match(await (await import('node:fs/promises')).readFile(`${ctx.fixture.root}/REPORT.md`, 'utf8'), /All good/);

    const output = ctx.stdout.getData();
    assert.match(output, /summary/);
    assert.match(output, /REPORT\.md/);
    assert.ok(!output.includes('nvapi-test-key-123456'));

    const sessions = await ctx.app.sessionStore.list();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].task, 'create a report');

    const saved = await ctx.app.sessionStore.load(summary.sessionId);
    assert.equal(saved.status, 'completed');
    assert.ok(saved.changedFiles.includes('REPORT.md'));
    assert.ok(Array.isArray(saved.transcript));
  } finally {
    await ctx.cleanup();
  }
});

test('renders a Markdown final answer with a width-aware table', async () => {
  const ctx = await setup({
    responses: [
      response({ content: '**Done**\n\n| File | Status |\n|---|---|\n| REPORT.md | created |' }),
    ],
  });
  try {
    const summary = await ctx.app.runTask('format a report');
    assert.equal(summary.status, 'completed');
    const output = ctx.stdout.getData();
    assert.match(output, /Done/);
    assert.match(output, /REPORT\.md/);
    assert.match(output, /╭/);
    assert.ok(!output.includes('|---|'));
    assert.ok(output.includes('│ REPORT.md'));
  } finally {
    await ctx.cleanup();
  }
});

test('non-interactive command execution is denied and no process runs', async () => {
  const ctx = await setup({
    responses: [
      response({ toolCalls: [toolCall('run_command', { argv: [process.execPath, '-e', "console.log('NOPE')"] })] }),
      response({ content: 'The command needed approval and was denied.' }),
    ],
    policy: 'ask',
  });
  try {
    const summary = await ctx.app.runTask('run something');
    assert.equal(summary.status, 'completed');
    assert.equal(summary.commands.length, 0);
    assert.ok(!ctx.stdout.getData().includes('NOPE'));
  } finally {
    await ctx.cleanup();
  }
});

test('--auto-approve runs commands in non-interactive mode without prompting', async () => {
  const fixture = await createTestWorkspace();
  const config = testConfig(fixture.root, { approvalPolicy: 'ask' });
  const provider = new ScriptedProvider([
    response({ toolCalls: [toolCall('run_command', { argv: [process.execPath, '-e', "console.log('AUTO_OK')"] })] }),
    response({ content: 'The command ran without asking the user.' }),
  ]);
  const stdout = captureStream();
  const stderr = captureStream();
  const app = await createApp({
    config,
    cliOptions: { interactive: false, plain: true, autoApprove: true },
    stdout,
    stderr,
    input: fakeInput(),
    provider,
    version: '0.1.0',
  });
  try {
    const summary = await app.runTask('run something without asking');
    assert.equal(summary.status, 'completed');
    assert.equal(summary.commands.length, 1, 'the command must actually execute under --auto-approve');
    assert.equal(summary.commands[0].exitCode, 0);
    assert.match(stdout.getData(), /AUTO_OK/);
    assert.equal(summary.approvals.denied, 0, 'nothing may be denied under --auto-approve');
    assert.ok(summary.approvals.approved >= 1, 'the approval must be recorded as auto-approved');
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test('--auto-approve without the flag still denies exec when policy is ask', async () => {
  const fixture = await createTestWorkspace();
  const config = testConfig(fixture.root, { approvalPolicy: 'ask' });
  const provider = new ScriptedProvider([
    response({ toolCalls: [toolCall('run_command', { argv: [process.execPath, '-e', "console.log('STILL_DENIED')"] })] }),
    response({ content: 'Denied as expected.' }),
  ]);
  const stdout = captureStream();
  const stderr = captureStream();
  const app = await createApp({
    config,
    cliOptions: { interactive: false, plain: true },
    stdout,
    stderr,
    input: fakeInput(),
    provider,
    version: '0.1.0',
  });
  try {
    const summary = await app.runTask('try to run something');
    assert.equal(summary.status, 'completed');
    assert.equal(summary.commands.length, 0, 'exec must remain denied without --auto-approve');
    assert.ok(!stdout.getData().includes('STILL_DENIED'));
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test('slash commands work: status, files, tools, config, sessions, diff, undo', async () => {
  const ctx = await setup({
    responses: [
      response({ toolCalls: [toolCall('edit_file', { path: 'src/app.js', old_text: 'hello ${name}', new_text: 'greetings ${name}' })] }),
      response({ content: 'Edited the greeting.' }),
    ],
  });
  try {
    const summary = await ctx.app.runTask('edit greeting');
    assert.equal(summary.status, 'completed');
    ctx.stdout.reset();

    const run = (name, args = '') => ctx.app.commands.execute({ name, args, parts: args.split(/\s+/).filter(Boolean) });

    await run('status');
    assert.match(ctx.stdout.getData(), /model\s+test\/model/);

    ctx.stdout.reset();
    await run('files');
    assert.match(ctx.stdout.getData(), /src/);

    ctx.stdout.reset();
    await run('tools');
    assert.match(ctx.stdout.getData(), /read_file/);

    ctx.stdout.reset();
    await run('config');
    const configOutput = ctx.stdout.getData();
    assert.match(configOutput, /set \(redacted\)/);
    assert.ok(!configOutput.includes('nvapi-test-key-123456'));

    ctx.stdout.reset();
    await run('sessions');
    assert.match(ctx.stdout.getData(), /edit greeting/);

    ctx.stdout.reset();
    await run('diff');
    assert.match(ctx.stdout.getData(), /greetings/);

    ctx.stdout.reset();
    await run('undo', 'confirm');
    assert.match(ctx.stdout.getData(), /Reverted/);
    assert.match((await ctx.fixture.workspace.readText('src/app.js')).text, /hello \$\{name\}/);
  } finally {
    await ctx.cleanup();
  }
});

test('/model lists the catalog and switches by number, rejecting raw ids', async () => {
  // Use a catalog model as the starting point so the '← current' marker is real.
  const ctx = await setup({ responses: [], configOverrides: { model: 'nvidia/nemotron-3.5-super-vl-120b-a12b' } });
  try {
    const run = (args = '') =>
      ctx.app.commands.execute({ name: 'model', args, parts: args ? args.split(/\s+/) : [] });

    await run('');
    const listing = ctx.stdout.getData();
    assert.match(listing, /Available models:/);
    assert.match(listing, /1 {2}nvidia\/nemotron-3\.5-super-vl-120b-a12b {2}← current/);
    assert.match(listing, /2 {2}z-ai\/glm-5.3-flash/);
    assert.match(listing, /nvidia\/nemotron-3\.5-super-vl-120b-a12b/);
    assert.match(listing, /google\/diffusiongemma-26b-a4b-it/);
    assert.match(listing, /poolside\/laguna-xs-2\.1/);
    assert.match(listing, /stepfun-ai\/step-5-preview/);
    assert.match(listing, /← current/);
    assert.match(listing, /Usage: \/model <n>/);

    ctx.stdout.reset();
    await run('2');
    assert.match(ctx.stdout.getData(), /Model set to z-ai\/glm-5.3-flash \(#2\)/);
    assert.match(ctx.stdout.getData(), /saved, so it stays selected in future runs/);
    assert.equal(ctx.config.model, 'z-ai/glm-5.3-flash');
    assert.equal(ctx.provider.config.model, 'z-ai/glm-5.3-flash');
    const prefs = JSON.parse(
      await (await import('node:fs/promises')).readFile(`${ctx.fixture.root}/.ryuu/preferences.json`, 'utf8'),
    );
    assert.equal(prefs.model, 'z-ai/glm-5.3-flash', '/model must persist the choice for future runs');

    ctx.stdout.reset();
    await run('nvidia/nemotron-3.5-super-vl-120b-a12b');
    assert.match(ctx.stdout.getData(), /Use a number, not a model id/);
    assert.equal(ctx.config.model, 'z-ai/glm-5.3-flash', 'raw model ids must be rejected');

    ctx.stdout.reset();
    await run('');
    assert.match(
      ctx.stdout.getData(),
      /2 {2}z-ai\/glm-5.3-flash {2}← current/,
      'the marker must move to the newly selected model',
    );

    ctx.stdout.reset();
    await run('99');
    assert.match(ctx.stdout.getData(), /Unknown model number: 99\. Valid: 1-5/);
  } finally {
    await ctx.cleanup();
  }
});

test('the composer stays usable while a task runs: commands execute, prompts are refused', async () => {
  const fixture = await createTestWorkspace();
  const config = testConfig(fixture.root);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const provider = new ScriptedProvider([
    async () => {
      await gate;
      return response({ content: 'selesai' });
    },
  ]);
  const stdout = ttyCapture();
  const input = ttyInput();
  const app = await createApp({
    config,
    cliOptions: { interactive: true, plain: false, color: true },
    stdout,
    stderr: captureStream(),
    input,
    provider,
    version: '0.1.0',
  });

  const running = app.runInteractive();
  try {
    await wait(20);
    input.write('kerjakan sesuatu\r');
    await wait(30);
    assert.equal(provider.calls.length, 1, 'the task reached the model and is still running');

    // A slash command with an argument runs immediately, mid-task.
    stdout.reset();
    input.write('/help addmodel\r');
    await wait(30);
    assert.match(stdout.getData(), /How to use:/, 'commands run while the agent works');

    // A second prompt is refused, and never reaches the model.
    stdout.reset();
    input.write('prompt kedua\r');
    await wait(30);
    assert.match(stdout.getData(), /A task is already running/);
    assert.equal(provider.calls.length, 1, 'a second prompt is not queued behind the task');

    // The task itself was never interrupted and still finishes.
    stdout.reset();
    release();
    await wait(60);
    assert.match(stdout.getData(), /selesai/);

    input.write('/exit\r');
    await running;
  } finally {
    release();
    await app.close().catch(() => {});
    await running.catch(() => {});
    await fixture.cleanup();
  }
});

test('close() stops any running processes', async () => {
  const ctx = await setup({ responses: [] });
  try {
    const record = ctx.app.processes.start({ argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], timeoutMs: 0 });
    assert.equal(record.status, 'running');
    await ctx.app.close();
    assert.notEqual(record.status, 'running');
    await ctx.cleanup();
  } catch (error) {
    await ctx.cleanup();
    throw error;
  }
});

test('conversation memory carries across tasks and /memory, /resume, /clear drive it', async () => {
  const ctx = await setup({
    responses: [
      response({ content: 'FIRST_ANSWER: greeting renamed to hi' }),
      response({ content: 'SECOND_ANSWER: you asked me to rename it' }),
      response({ content: 'THIRD_ANSWER: starting over with no history' }),
    ],
  });
  try {
    await ctx.app.runTask('remember the greeting rename');
    const first = JSON.stringify(ctx.provider.calls[0].messages);
    assert.ok(first.includes('remember the greeting rename'));
    assert.ok(!first.includes('FIRST_ANSWER'), 'memory must start empty for the first task');

    await ctx.app.runTask('what did I ask you first?');
    const second = JSON.stringify(ctx.provider.calls[1].messages);
    assert.ok(second.includes('remember the greeting rename'), 'the previous task must be sent as context');
    assert.ok(second.includes('FIRST_ANSWER: greeting renamed'), 'the previous answer must be sent as context');
    assert.ok(second.includes('what did I ask you first?'), 'the current task must still be the last turn');

    const run = (name, args = '') =>
      ctx.app.commands.execute({ name, args, parts: args ? args.split(/\s+/) : [] });

    ctx.stdout.reset();
    await run('memory');
    const memoryOutput = ctx.stdout.getData();
    assert.match(memoryOutput, /Conversation memory: 2 task\(s\)/);
    assert.match(memoryOutput, /remember the greeting rename/);

    // One session file per task; the newest one carries the full conversation.
    const sessions = await ctx.app.sessionStore.list();
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].task, 'what did I ask you first?');
    ctx.stdout.reset();
    await run('resume', sessions[0].id);
    assert.match(ctx.stdout.getData(), /Resumed 4 message\(s\)/);
    assert.equal(ctx.app.agent.getConversation().length, 4);

    ctx.stdout.reset();
    await run('clear');
    assert.match(ctx.stdout.getData(), /Conversation memory and the session worklog were cleared/);
    assert.equal(ctx.app.agent.getConversation().length, 0);

    // After /clear the provider must no longer receive the remembered history.
    await ctx.app.runTask('GAMMA: start over');
    assert.ok(!JSON.stringify(ctx.provider.calls[2].messages).includes('remember the greeting rename'));
  } finally {
    await ctx.cleanup();
  }
});
