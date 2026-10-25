import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { createApp } from '../../src/cli/app.js';
import { Renderer } from '../../src/cli/renderer.js';
import { createTestWorkspace, RecordingRenderer, ScriptedProvider, response, testConfig, toolCall } from '../helpers.js';

function ttyStream(columns = 120) {
  let data = '';
  const stream = new Writable({
    write(chunk, encoding, callback) {
      data += chunk.toString();
      callback();
    },
  });
  stream.isTTY = true;
  stream.columns = columns;
  stream.rows = 40;
  stream.cursorTo = () => true;
  stream.clearLine = () => true;
  stream.moveCursor = () => true;
  stream.getData = () => data;
  return stream;
}

function silentInput() {
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  stream.isTTY = false;
  return stream;
}

const strip = (text) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');

test('the TUI prints the exact lines an edit changed', async () => {
  const stdout = ttyStream();
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });
  const fixture = await createTestWorkspace();
  const config = testConfig(fixture.root, { approvalPolicy: 'auto' });
  const provider = new ScriptedProvider([
    response({ toolCalls: [toolCall('edit_file', { path: 'src/app.js', old_text: 'hello ${name}', new_text: 'hi ${name}' })] }),
    response({ content: 'Renamed the greeting.' }),
  ]);
  const app = await createApp({
    config,
    cliOptions: { interactive: false, plain: false },
    stdout,
    stderr: stdout,
    input: silentInput(),
    provider,
    renderer,
    version: '0.1.0',
  });
  try {
    const summary = await app.runTask('rename the greeting');
    assert.equal(summary.status, 'completed');
    const visible = strip(stdout.getData());
    assert.match(visible, /• Edit src\/app\.js/, 'the user must see which file was edited');
    assert.match(visible, /-  return `hello \$\{name\}`;/, 'the removed line must be shown');
    assert.match(visible, /\+  return `hi \$\{name\}`;/, 'the added line must be shown');
    assert.match(visible, /model \d+\.\d+s/, 'every model call must report its latency');
    assert.match(visible, /step 1/, 'the live line must name the step');
    assert.match(visible, /summary/);
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test('command output is forwarded to the UI before the command exits', async () => {
  const fixture = await createTestWorkspace();
  const config = testConfig(fixture.root, { approvalPolicy: 'auto' });
  const renderer = new RecordingRenderer();
  const provider = new ScriptedProvider([
    response({ toolCalls: [toolCall('run_command', {
      argv: [process.execPath, '-e', "setTimeout(() => { console.log('LIVE_OUT'); }, 120);"],
      timeout_ms: 10000,
    })] }),
    response({ content: 'The command finished.' }),
  ]);
  const app = await createApp({
    config,
    cliOptions: { interactive: false, plain: true, autoApprove: true },
    stdout: ttyStream(),
    stderr: ttyStream(),
    input: silentInput(),
    provider,
    renderer,
    version: '0.1.0',
  });
  try {
    const summary = await app.runTask('run the check');
    assert.equal(summary.status, 'completed');
    assert.equal(summary.commands.length, 1, 'the command must really run');
    const live = renderer.events.filter((event) => event.event === 'processOutput');
    assert.ok(live.length > 0, 'stdout must reach the renderer while the tool is running');
    assert.match(live.map((event) => event.payload.text).join(''), /LIVE_OUT/);
    assert.equal(live[0].payload.stream, 'stdout');
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
