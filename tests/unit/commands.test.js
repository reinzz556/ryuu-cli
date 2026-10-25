import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommands, parseCommandLine } from '../../src/cli/commands.js';
import { createTestWorkspace } from '../helpers.js';

/** Renderer stub that captures slash-command output. */
class LineRecorder {
  constructor() {
    this.chunks = [];
  }

  lines(text = '') {
    this.chunks.push(String(text));
  }

  success(message) {
    this.chunks.push(`[success] ${message}`);
  }

  get text() {
    return this.chunks.join('\n');
  }
}

async function makeCommands(extra = {}) {
  const { workspace, config, cleanup } = await createTestWorkspace();
  const renderer = new LineRecorder();
  const commands = createCommands({
    config,
    workspace,
    registry: { list: () => [], get: () => null },
    processes: { list: () => [], getOutput: () => null },
    sessionStore: { list: async () => [], load: async () => null },
    undo: { size: 0, entries: [], list: () => [] },
    renderer,
    provider: { config },
    interactive: true,
    getAgent: () => null,
    getLastSummary: () => null,
    getActiveTask: () => null,
    confirmLocal: async () => false,
    ...extra,
  });
  return { commands, renderer, cleanup };
}

test('parseCommandLine recognizes slash commands only', () => {
  assert.deepEqual(parseCommandLine('/help'), { name: 'help', args: '', parts: [] });
  assert.deepEqual(parseCommandLine('/status extra'), { name: 'status', args: 'extra', parts: ['extra'] });
  assert.equal(parseCommandLine('do the thing'), null);
  assert.equal(parseCommandLine(''), null);
});

test('/expand lists blocks, opens a block by id and rejects unknown ids', async () => {
  const opened = [];
  const warnings = [];
  const renderer = new LineRecorder();
  renderer.blockListText = () => '  #1  reasoning    42 chars';
  renderer.hasBlock = (id) => id === 1;
  renderer.openBlockView = (id) => {
    opened.push(id);
    return true;
  };
  renderer.warn = (message) => warnings.push(message);

  const { commands, cleanup } = await makeCommands({ renderer });
  try {
    await commands.execute(parseCommandLine('/expand'));
    assert.match(renderer.text, /#1\s+reasoning/);

    await commands.execute(parseCommandLine('/expand 1'));
    assert.deepEqual(opened, [1]);

    await commands.execute(parseCommandLine('/expand 99'));
    assert.match(warnings.at(-1), /No block #99/);

    await commands.execute(parseCommandLine('/expand nope'));
    assert.match(warnings.at(-1), /Usage: \/expand/);
  } finally {
    await cleanup();
  }
});

test('/help lists slash commands', async () => {
  const { commands, renderer, cleanup } = await makeCommands();
  try {
    await commands.execute(parseCommandLine('/help'));
    const text = renderer.text;
    assert.match(text, /Ryuu commands/);
    assert.match(text, /\/help/);
    assert.match(text, /\/exit/);
    assert.match(text, /Anything not starting with \/ is sent to the agent as a task\./);
  } finally {
    await cleanup();
  }
});

test('/help documents every CLI flag with a description', async () => {
  const { commands, renderer, cleanup } = await makeCommands();
  try {
    await commands.execute(parseCommandLine('/help'));
    const text = renderer.text;
    assert.match(text, /CLI flags/);
    assert.match(text, /ryuu --auto-approve/);
    // Every startup flag is listed and explained.
    for (const flag of [
      '--help',
      '--version',
      '--doctor',
      '--workspace',
      '--model',
      '--max-steps',
      '--yes',
      '--auto-approve',
      '--read-only',
      '--env-file',
      '--no-color',
      '--plain',
      '--debug',
    ]) {
      assert.ok(text.includes(flag), `/help output must mention ${flag}`);
    }
    // Key flags carry an explanation, not just a name.
    assert.match(text, /--auto-approve\s+auto-approve ALL actions incl\. commands/);
    assert.match(text, /--yes\s+auto-approve file writes/);
    assert.match(text, /--read-only\s+deny all writes and command execution/);
  } finally {
    await cleanup();
  }
});

test('/help <command> shows usage for one command', async () => {
  const { commands, renderer, cleanup } = await makeCommands();
  try {
    await commands.execute(parseCommandLine('/help exit'));
    assert.match(renderer.text, /\/exit \/exit/);
    await commands.execute(parseCommandLine('/help nope'));
    assert.match(renderer.text, /Unknown command: \/nope\. Run \/help\./);
  } finally {
    await cleanup();
  }
});

test('/addmodel and /delmodel change the /model list, and /help documents them', async () => {
  const { commands, renderer, cleanup } = await makeCommands();
  const run = async (line) => {
    renderer.chunks.length = 0;
    await commands.execute(parseCommandLine(line));
    return renderer.text;
  };
  const id = 'meta-llama/llama-3.3-70b-instruct';
  try {
    const added = await run(`/addmodel ${id}`);
    assert.match(added, /Added meta-llama\/llama-3\.3-70b-instruct to the model list \(#\d+\)/);
    assert.match(added, /not checked|No availability check/);

    const list = await run('/model');
    assert.match(list, /0 added|1 added/);
    assert.match(list, new RegExp(`${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\(added\\)`));

    // Selecting an added model persists both the choice and the list.
    const index = Number(added.match(/\(#(\d+)\)/)[1]);
    const selected = await run(`/model ${index}`);
    assert.match(selected, new RegExp(`Model set to ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

    assert.match(await run(`/addmodel ${id}`), /already in the model list/);
    assert.match(await run('/addmodel bad id'), /not a usable model id/);
    assert.match(
      await run('/delmodel nvidia/nemotron-3.5-super-vl-120b-a12b'),
      /built-in catalog model and cannot be removed/,
    );

    const removed = await run(`/delmodel ${id}`);
    assert.match(removed, /Removed meta-llama\/llama-3\.3-70b-instruct from the model list/);
    assert.match(removed, /still the current model for this session/);
    assert.doesNotMatch(await run('/model'), /\(added\)/);

    const help = await run('/help addmodel');
    assert.match(help, /How to use:/);
    assert.match(help, /\/delmodel <model-id>/);
    assert.match(await run('/help delmodel'), /How to use:/);
    assert.match(await run('/help delmodel'), /cannot be deleted/);
  } finally {
    await cleanup();
  }
});

test('/web reports provider status, keys, discovery and enable/disable', async () => {
  const calls = [];
  const webSearch = {
    fallbackEnabled: true,
    timeoutMs: 6000,
    maxRetries: 1,
    list: () => [
      {
        id: 'you',
        label: 'You.com',
        transport: 'streamable-http',
        enabled: true,
        configured: true,
        capabilities: { search: true, extract: false },
        connected: false,
        lastStatus: null,
      },
      {
        id: 'tavily',
        label: 'Tavily',
        transport: 'streamable-http',
        enabled: true,
        configured: false,
        capabilities: { search: true, extract: true },
        connected: false,
        lastStatus: null,
      },
    ],
    probe: async () => [
      { id: 'you', label: 'You.com', ok: true, durationMs: 12, tools: ['you-search'], capabilities: { search: true } },
      { id: 'tavily', label: 'Tavily', ok: false, skipped: true, reason: 'API key belum dikonfigurasi' },
    ],
    setEnabled: (id, enabled) => {
      calls.push([id, enabled]);
      return id === 'you';
    },
  };
  const { commands, renderer, cleanup } = await makeCommands({ webSearch });
  try {
    await commands.execute(parseCommandLine('/web status'));
    assert.match(renderer.text, /WEB SEARCH/);
    assert.match(renderer.text, /you → tavily/);
    assert.match(renderer.text, /missing key/);

    await commands.execute(parseCommandLine('/web providers'));
    assert.match(renderer.text, /YDC_API_KEY/);
    assert.match(renderer.text, /TAVILY_API_KEY/);

    await commands.execute(parseCommandLine('/web test'));
    assert.match(renderer.text, /you-search/);
    assert.match(renderer.text, /no provider was queried/i);

    await commands.execute(parseCommandLine('/web disable you'));
    assert.deepEqual(calls, [['you', false]]);
    assert.match(renderer.text, /not written to disk/);
  } finally {
    await cleanup();
  }
});

test('/copy asks the renderer for a sent prompt and reports why it cannot', async () => {
  const warnings = [];
  const copied = [];
  let next = { ok: true, chars: 16 };
  const renderer = new LineRecorder();
  renderer.warn = (message) => warnings.push(message);
  renderer.copyTask = (which) => {
    copied.push(which);
    return next;
  };
  const { commands, cleanup } = await makeCommands({ renderer });
  try {
    await commands.execute(parseCommandLine('/copy'));
    await commands.execute(parseCommandLine('/copy 2'));
    assert.deepEqual(copied, [0, 2], 'no argument means the latest prompt, a number walks back');

    await commands.execute(parseCommandLine('/copy abc'));
    assert.match(warnings.at(-1), /Usage: \/copy/);

    next = { ok: false, reason: 'no-task', chars: 0 };
    await commands.execute(parseCommandLine('/copy'));
    assert.match(warnings.at(-1), /Nothing to copy/);

    next = { ok: false, reason: 'no-tty', chars: 0 };
    await commands.execute(parseCommandLine('/copy'));
    assert.match(warnings.at(-1), /OSC 52/);
  } finally {
    await cleanup();
  }
});

test('unknown slash commands point back to /help', async () => {
  const { commands, renderer, cleanup } = await makeCommands();
  try {
    await commands.execute(parseCommandLine('/does-not-exist'));
    assert.match(renderer.text, /Unknown command: \/does-not-exist\. Run \/help\./);
  } finally {
    await cleanup();
  }
});
