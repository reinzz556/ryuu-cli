import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import { Chalk } from 'chalk';
import {
  Transcript,
  Tui,
  bannerRows,
  blockRule,
  clipLine,
  gradient,
  layoutTranscript,
  toolHeader,
  wrapAnsi,
} from '../../src/cli/tui.js';
import { parseArgs } from '../../src/index.js';
import { readVersion } from '../../src/utils/version.js';
import { displayWidth } from '../../src/cli/width.js';

const c = new Chalk({ level: 0 });
const painted = new Chalk({ level: 3 });
const stripAnsi = (text) => String(text).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
const SKY = '\x1b[38;2;56;189;248m';
const WHITE = '\x1b[38;2;226;232;240m';
const GREEN = '\x1b[38;2;74;222;128m';
const YELLOW = '\x1b[38;2;251;191;36m';
const RED = '\x1b[38;2;239;68;68m';
const RED_SOFT = '\x1b[38;2;252;165;165m';
const GRAY = '\x1b[38;2;156;163;175m';

function ui() {
  const input = new PassThrough();
  input.isTTY = false;
  input.setRawMode = () => input;
  const output = new PassThrough();
  output.isTTY = false;
  output.columns = 80;
  output.rows = 24;
  output.write = () => true;
  return new Tui({ input, output });
}

test('--tui is opt-in and leaves the default interface alone', () => {
  assert.equal(parseArgs(['--tui']).tui, true);
  assert.equal(parseArgs([]).tui, false);
  assert.equal(parseArgs(['--tui', '--plain']).plain, true);
});

test('every block keeps its own expanded state', () => {
  const transcript = new Transcript();
  const first = transcript.reasoningStart();
  transcript.reasoningAppend(first, 'alpha reasoning text');
  transcript.reasoningEnd(first);
  const second = transcript.reasoningStart();
  transcript.reasoningAppend(second, 'beta reasoning text');
  transcript.reasoningEnd(second);
  const third = transcript.command({ argv: ['npm', 'test'], stdout: 'ok\n' });

  transcript.expand(first.id, true);
  transcript.expand(third.id, true);

  assert.equal(first.expanded, true);
  assert.equal(second.expanded, false, 'opening one block never opens another');
  assert.equal(third.expanded, true, 'reasoning and command blocks are independent');
  assert.equal(transcript.get(first.id).text, 'alpha reasoning text', 'content stays bound to its block');

  transcript.toggle(second.id);
  assert.equal(second.expanded, true);
  assert.equal(first.expanded, true, 'toggling one block does not reset the others');
  transcript.toggle(first.id);
  assert.equal(first.expanded, false);
  assert.equal(transcript.get(first.id).text, 'alpha reasoning text', 'closing keeps the text');
});

test('an expanded block shows every line; a closed one shows a bounded preview', () => {
  const transcript = new Transcript();
  const block = transcript.command({
    argv: ['seq', '1', '12'],
    stdout: Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join('\n'),
  });
  const collapsed = layoutTranscript(transcript, 60, { c, color: false }).map((row) => row.text).join('\n');
  assert.match(collapsed, /line-12/);
  assert.doesNotMatch(collapsed, /line-3\b/, 'the preview keeps only the tail');

  transcript.expand(block.id, true);
  const expanded = layoutTranscript(transcript, 60, { c, color: false }).map((row) => row.text).join('\n');
  assert.match(expanded, /line-1\b/, 'expanding shows the complete output');
  assert.match(expanded, /line-12/);
  assert.ok(expanded.split('\n').length > collapsed.split('\n').length);
});

test('layout rows are tagged with the block they belong to', () => {
  const transcript = new Transcript();
  const reasoning = transcript.reasoningStart();
  transcript.reasoningAppend(reasoning, 'do the thing');
  transcript.reasoningEnd(reasoning);
  const rows = layoutTranscript(transcript, 60, { c, color: false });
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((row) => row.itemId === reasoning.id));
});

test('a click toggles the block under the pointer, and the wheel scrolls', () => {
  const tui = ui();
  try {
    const reasoning = tui.transcript.reasoningStart();
    tui.transcript.reasoningAppend(reasoning, 'clickable');
    tui.transcript.reasoningEnd(reasoning);

    tui.viewport = 5;
    tui.clickMap = [reasoning.id, reasoning.id, null, null, null];
    tui.handleMouseReport(['', '0', '5', '2', 'M']); // screen row 2 = first transcript row
    assert.equal(reasoning.expanded, true, 'clicking a block opens it');
    tui.handleMouseReport(['', '0', '5', '2', 'm']);
    assert.equal(reasoning.expanded, true, 'a release event does not toggle');

    tui.handleMouseReport(['', '0', '5', '3', 'M']);
    assert.equal(reasoning.expanded, false, 'clicking the same block again closes it');

    tui.maxScroll = 10;
    tui.scroll = 5;
    tui.handleMouseReport(['', '65', '1', '1', 'M']); // wheel down
    assert.equal(tui.scroll, 2, 'the wheel scrolls the transcript');
  } finally {
    tui.close();
  }
});

test('the composer submits typed text and long pastes resolve to the original', async () => {
  const tui = ui();
  try {
    const first = tui.ask('› ');
    tui.insertText('halo ');
    tui.insertText('dunia');
    tui.submit();
    assert.equal(await first, 'halo dunia');

    const pasted = 'z'.repeat(1500);
    const second = tui.ask('› ');
    tui.push(`\x1b[200~${pasted}\x1b[201~`);
    assert.equal(tui.composer.text, '> [Pasted text #1 1500 chars]', 'the composer only shows a placeholder');
    tui.submit();
    assert.equal(await second, pasted, 'the original text is what gets sent');

    const third = tui.ask('› ');
    tui.insertText('salah');
    tui.submit();
    assert.equal(await third, 'salah');
  } finally {
    tui.close();
  }
});

test('the composer edits with backspace, history and cursor keys', async () => {
  const tui = ui();
  try {
    tui.insertText('abc');
    tui.handleKey('left');
    tui.handleControl('\x7f');
    assert.equal(tui.composer.text, 'ac');
    assert.equal(tui.composer.cursor, 1);
    tui.reset();
    assert.deepEqual(tui.composer, { text: '', cursor: 0 });

    const first = tui.ask('› ');
    tui.insertText('first');
    tui.submit();
    await first;
    const second = tui.ask('› ');
    tui.handleKey('up');
    assert.equal(tui.composer.text, 'first', 'Up recalls the previous line');
    tui.submit();
    assert.equal(await second, 'first');
  } finally {
    tui.close();
  }
});

test('clipLine never exceeds the terminal width and keeps ANSI intact', () => {
  const colour = new Chalk({ level: 1 }).red('x'.repeat(200));
  const clipped = clipLine(colour, 20);
  assert.ok(clipped.includes('\x1b[31m'), 'the colour sequence survives clipping');
  assert.ok(displayWidth(clipped, { ansi: true }) <= 20);
  assert.ok(clipped.endsWith('…'));
  assert.equal(clipLine('abc', 20), 'abc', 'short lines are untouched');
});

test('blocks are separated by a blank row and a grey rule, and every row knows its block', () => {
  const transcript = new Transcript();
  transcript.message('first note');
  transcript.message('second note');
  const rows = layoutTranscript(transcript, 60, { c, color: false });
  assert.deepEqual(
    rows.map((row) => row.text),
    [' first note', '', ` ${'─'.repeat(58)}`, ' second note'],
    'a blank row and a rule sit between two blocks',
  );
  assert.equal(rows[1].itemId, null, 'the separator belongs to no block');
  assert.equal(rows[2].itemId, null, 'the rule belongs to no block');
  assert.equal(rows[3].itemId, 2, 'the row still maps back to its block for clicks');
});

test('consecutive tool calls stay in one block without a divider', () => {
  const transcript = new Transcript();
  transcript.add({ kind: 'tool', name: 'read_file', ok: true, durationMs: 4, summary: 'a.js' });
  transcript.add({ kind: 'tool', name: 'read_file', ok: true, durationMs: 5, summary: 'b.js' });
  transcript.add({ kind: 'tool', name: 'search', ok: true, durationMs: 6, summary: 'greeting' });
  transcript.add({ kind: 'answer', text: 'done' });

  const texts = layoutTranscript(transcript, 60, { c, color: false }).map((row) => row.text);
  assert.match(texts[0], /Using tools · 3 calls/, 'one small header opens the group');
  assert.match(texts[1], /read_file/, 'the first tool follows the header');
  assert.match(texts[2], /read_file/, 'the next tool follows on the very next row');
  assert.match(texts[3], /search/);
  assert.equal(texts.filter((text) => text.includes('─')).length, 1, 'only the change of kind draws a rule');
  const ruleAt = texts.findIndex((text) => text.includes('─'));
  assert.equal(ruleAt, 5, 'the rule sits between the tool block and the answer');
  assert.match(texts[6], /response/, 'the answer block has its own small header');
  assert.match(texts[7], /done/, 'the answer follows the divider');
});

test('the divider is a pink → violet → sky gradient', () => {
  const rule = blockRule(40, painted);
  assert.equal(stripAnsi(rule).trim(), '─'.repeat(38), 'it spans the row as plain dashes');
  const codes = [...rule.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)].map((match) => match.slice(1).map(Number));
  assert.deepEqual(codes[0], [244, 114, 182], 'it starts pink');
  assert.deepEqual(codes[codes.length - 1], [56, 189, 248], 'it ends sky blue');
  const middle = codes[Math.floor(codes.length / 2)];
  assert.ok(
    Math.abs(middle[0] - 167) <= 4 && Math.abs(middle[1] - 139) <= 4 && Math.abs(middle[2] - 250) <= 4,
    'it passes through violet in the middle',
  );
});

test('the tools header is a pink → blue gradient label', () => {
  const header = toolHeader(2, { c: painted });
  assert.equal(stripAnsi(header), ' ⚙ Using tools · 2 calls');
  assert.ok(header.includes('\x1b[1m'), 'it is bold');
  assert.ok(header.includes('\x1b[38;2;244;114;182m'), 'it starts pink');
  assert.ok(header.includes('\x1b[38;2;56;189;248m'), 'it ends sky blue');
});

test('streamed text after a tool opens a new answer block below it', () => {
  const tui = ui();
  try {
    tui.taskStart({ task: 'do it', sessionId: 's', maxSteps: 4 });
    tui.contentDelta({ text: 'first part ' });
    tui.toolStart({ name: 'read_file' });
    tui.toolEnd({ name: 'read_file', ok: true, durationMs: 3, summary: 'a.js' });
    tui.contentDelta({ text: 'second part' });

    assert.deepEqual(
      tui.transcript.items.map((item) => item.kind),
      ['task', 'answer', 'tool', 'answer'],
      'a new step starts a new answer block after the tool',
    );
    const answers = tui.transcript.items.filter((item) => item.kind === 'answer').map((item) => item.text);
    assert.deepEqual(answers, ['first part ', 'second part'], 'the older block is never extended from below');

    const rows = layoutTranscript(tui.transcript, 60, { c, color: false }).map((row) => row.text);
    const toolAt = rows.findIndex((row) => row.includes('read_file'));
    const secondAt = rows.findIndex((row) => row.includes('second part'));
    assert.ok(toolAt !== -1 && secondAt > toolAt, 'the newer text renders after the tool, not above it');

    assert.equal(tui.streamedResponse(), true, 'the session still knows an answer streamed');
    tui.final({
      status: 'completed',
      steps: 2,
      durationMs: 10,
      finalText: 'first part second part',
      tokenUsage: { prompt: 1, completion: 2 },
      changedFiles: [],
    });
    assert.equal(
      tui.transcript.items.filter((item) => item.kind === 'answer').length,
      2,
      'the final text is not duplicated when it already streamed',
    );
  } finally {
    tui.close();
  }
});

test('the banner fits any terminal width and keeps the ascii wordmark when it fits', () => {
  const header = {
    version: '9.9.9',
    model: 'nvidia/llama-3.1',
    workspace: '/home/dev/projects/a/very/long/workspace/path',
    node: 'v25.9.0',
    approvalPolicy: 'ask',
  };
  for (const width of [26, 30, 34, 48, 60, 100, 140]) {
    const rows = bannerRows(header, width, { c: painted });
    const over = rows.filter((row) => displayWidth(row, { ansi: true }) > width);
    assert.equal(over.length, 0, `no banner row is wider than ${width} columns`);
    const plain = stripAnsi(rows.join('\n'));
    assert.match(plain, /◢ RYUU \/\/ AGENT OS/);
    assert.match(plain, /◆ TELEMETRY/);
    assert.match(plain, /workspace/);
  }
  assert.match(stripAnsi(bannerRows(header, 100, { c: painted }).join('\n')), /██████╗/, 'wide terminals get the full wordmark');
  assert.doesNotMatch(stripAnsi(bannerRows(header, 34, { c: painted }).join('\n')), /██████╗/, 'narrow terminals use the compact art');
  assert.doesNotMatch(
    stripAnsi(bannerRows(header, 26, { c: painted }).join('\n')),
    /v9\.9\.9/,
    'the version is dropped rather than clipped when there is no room',
  );
  assert.match(stripAnsi(bannerRows(header, 100, { c: painted }).join('\n')), /v9\.9\.9/);
});

test('each kind of row has its own colour', () => {
  const transcript = new Transcript();
  const reasoning = transcript.reasoningStart();
  transcript.reasoningAppend(reasoning, 'weighing the options');
  transcript.reasoningEnd(reasoning);
  const rows = layoutTranscript(transcript, 60, { c: painted, color: true });
  const [header, ...body] = rows.map((row) => row.text);
  assert.ok(header.includes(WHITE), 'the reasoning status line is white');
  assert.ok(header.includes(GREEN), 'its glyph is green');
  assert.ok(body.some((line) => line.includes(GREEN)), 'reasoning text is green');

  const okTool = new Transcript();
  okTool.add({ kind: 'tool', name: 'read_file', ok: true, durationMs: 8, summary: 'src/app.js' });
  const okRows = layoutTranscript(okTool, 60, { c: painted, color: true }).map((row) => row.text);
  assert.ok(
    okRows.some((line) => stripAnsi(line).includes('Using tools')),
    'the tool block opens with its header',
  );
  assert.ok(okRows.find((line) => line.includes('read_file')).includes(YELLOW), 'a tool name is yellow');

  const failedTool = new Transcript();
  failedTool.add({ kind: 'tool', name: 'run_command', ok: false, durationMs: 900, summary: 'exit 1: assertion failed' });
  const failedRows = layoutTranscript(failedTool, 60, { c: painted, color: true }).map((row) => row.text);
  const failedName = failedRows.findIndex((line) => line.includes('run_command'));
  assert.ok(failedRows[failedName].includes(`\x1b[1m${RED}`), 'a failed tool name is bold red');
  assert.ok(failedRows[failedName + 1].includes(`\x1b[2m${RED_SOFT}`), 'its output is dim bright red');
});

test('markdown answers stay white with sky-blue tables and accents', () => {
  const transcript = new Transcript();
  const answer = transcript.answerStart();
  transcript.answerAppend(answer, 'Intro text.\n\n| file | change |\n| --- | --- |\n| src/app.js | greeting |\n');
  const rows = layoutTranscript(transcript, 70, { c: painted, color: true }).map((row) => row.text);
  const joined = rows.join('\n');
  assert.ok(joined.includes(WHITE), 'prose is white');
  assert.ok(joined.includes(SKY), 'tables and accents are sky blue');
  assert.ok(rows.every((row) => displayWidth(row, { ansi: true }) <= 70));
});

test('the composer shows a gradient ryuu prompt, gray text and wraps at spaces', async () => {
  const tui = ui();
  tui.c = painted; // the piped test output has no colour depth of its own
  try {
    const empty = tui.composerLines(60);
    assert.match(stripAnsi(empty.rows[0]), /^ryuu > /);
    assert.ok(empty.rows[0].includes('\x1b[38;2;244;114;182m'), 'the prompt starts pink');
    assert.ok(empty.rows[0].includes('\x1b[38;2;96;165;250m'), 'the prompt ends blue');
    assert.ok(empty.rows[0].includes(GRAY), 'the input is gray');

    tui.insertText('a fairly long task that keeps going and should wrap across rows without being cut');
    const wrapped = tui.composerLines(44);
    assert.ok(wrapped.rows.length > 1, 'long input occupies more than one row');
    assert.ok(wrapped.rows.every((row) => displayWidth(row, { ansi: true }) <= 44));
    const plain = wrapped.rows.map(stripAnsi);
    assert.ok(plain[0].startsWith('ryuu > '));
    assert.ok(plain.slice(1).every((row) => row.startsWith(' '.repeat(7))), 'continuation rows align past the prompt');
    assert.equal(plain.join(' ').replace(/\s+/g, ' ').trim(), 'ryuu > a fairly long task that keeps going and should wrap across rows without being cut');
    assert.equal(wrapped.row, wrapped.rows.length - 1, 'the cursor tracks the last wrapped row');

    tui.reset();
    const asking = tui.ask('Approve this write?');
    const withQuestion = tui.composerLines(60);
    assert.match(stripAnsi(withQuestion.rows[0]), /Approve this write\?/);
    tui.insertText('yes');
    tui.submit();
    assert.equal(await asking, 'yes');
  } finally {
    tui.close();
  }
});

test('wrapAnsi breaks on words, respects the width and keeps colours', () => {
  const line = painted.hex('#38bdf8')('one two three four five six');
  const rows = wrapAnsi(line, 12);
  assert.ok(rows.length > 1);
  assert.ok(rows.every((row) => displayWidth(row, { ansi: true }) <= 12));
  assert.ok(rows.every((row) => row.includes(SKY)), 'the colour is re-opened on every wrapped row');
  assert.equal(stripAnsi(rows.join(' ')).replace(/\s+/g, ' ').trim(), 'one two three four five six');
});

test('gradient paints every character with its own colour', () => {
  const text = gradient(painted, 'ryuu', [
    [244, 114, 182],
    [96, 165, 250],
  ]);
  const codes = text.match(/\x1b\[38;2;[0-9;]+m/g);
  assert.equal(codes.length, 4);
  assert.equal(new Set(codes).size, 4, 'each letter gets a different colour');
  assert.equal(stripAnsi(text), 'ryuu');
});

function tuiWithClipboard() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  let paused = false;
  input.pause = () => {
    paused = true;
    return input;
  };
  const writes = [];
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 70;
  output.rows = 20;
  output.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  const tui = new Tui({ input, output });
  return { tui, writes, paused: () => paused };
}

const copiedText = (chunk) =>
  Buffer.from(chunk.slice(chunk.indexOf(';c;') + 3, chunk.indexOf('\x1b\\')), 'base64').toString('utf8');

test('a sent prompt shows a copy button, and clicking the prompt copies it', () => {
  const { tui, writes } = tuiWithClipboard();
  try {
    tui.taskStart({ task: 'fix the greeting', sessionId: 's1', maxSteps: 3 });
    const rows = layoutTranscript(tui.transcript, 70, { c, color: false }).map((row) => row.text);
    assert.match(rows[0], /⧉ copy/, 'the prompt header shows a copy chip');
    const task = tui.transcript.items.find((item) => item.kind === 'task');

    tui.viewport = 3;
    tui.clickMap = [task.id, task.id, null];
    tui.handleMouseReport(['', '0', '10', '2', 'M']);

    const sequence = writes.find((chunk) => chunk.includes('\x1b]52;c;'));
    assert.ok(sequence, 'the click writes an OSC 52 clipboard sequence');
    assert.equal(copiedText(sequence), 'fix the greeting', 'the exact prompt text is copied');
    assert.match(tui.toast.text, /copied prompt/);

    writes.length = 0;
    tui.handleControl('\x19');
    assert.ok(
      writes.some((chunk) => chunk.includes('\x1b]52;c;')),
      'Ctrl+Y copies the last prompt without the mouse',
    );
  } finally {
    tui.close();
  }
});

test('a code block shows a copy button, and clicking it copies only the code', () => {
  const { tui, writes } = tuiWithClipboard();
  try {
    tui.contentDelta({ text: 'Here is the fix:\n\n```js\nconst answer = 42;\n```\n' });
    tui.answerEnd();
    tui.forceRender();

    const rows = layoutTranscript(tui.transcript, 69, { c, color: false }).map((row) => row.text);
    assert.ok(
      rows.some((line) => line.includes('⧉ copy')),
      'the code block header shows a copy chip',
    );
    const index = tui.copyMap.findIndex(Boolean);
    assert.ok(index >= 0, 'the code block is a clickable copy target');

    tui.handleMouseReport(['', '0', '10', String(index + 2), 'M']);
    const sequence = writes.find((chunk) => chunk.includes('\x1b]52;c;'));
    assert.ok(sequence, 'the click writes an OSC 52 clipboard sequence');
    assert.equal(copiedText(sequence), 'const answer = 42;', 'only the code is copied, without fences');
    assert.match(tui.toast.text, /copied js code block/);
  } finally {
    tui.close();
  }
});

test('copyTask walks back through the sent prompts, newest first', () => {
  const { tui, writes } = tuiWithClipboard();
  try {
    tui.taskStart({ task: 'first task', sessionId: 'a', maxSteps: 1 });
    tui.taskStart({ task: 'second task', sessionId: 'b', maxSteps: 1 });
    assert.equal(tui.copyTask(0).ok, true);
    assert.equal(tui.copyTask(1).ok, true);
    const texts = writes
      .filter((chunk) => chunk.includes('\x1b]52;c;'))
      .map((chunk) => copiedText(chunk));
    assert.deepEqual(texts.slice(-2), ['second task', 'first task']);
  } finally {
    tui.close();
  }
});

test('closing the TUI releases stdin so /exit can end the process', () => {
  const { tui, paused } = tuiWithClipboard();
  tui.close();
  assert.equal(paused(), true, 'the input stream is paused once the session is over');
});

test('every version comes from package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(readVersion(), pkg.version);
  const tui = ui();
  try {
    assert.equal(tui.version, pkg.version, 'the TUI defaults to the package version');
    tui.banner({ model: 'm', workspace: '/tmp/w', node: 'v25', approvalPolicy: 'ask' });
    assert.match(stripAnsi(bannerRows(tui.header, 80, { c: painted }).join('\n')), new RegExp(`v${pkg.version.replace(/\./g, '\\.')}`));
  } finally {
    tui.close();
  }
});
