import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { Renderer } from '../../src/cli/renderer.js';

function capture({ isTTY = false, columns = 60 } = {}) {
  let data = '';
  const stream = new Writable({
    write(chunk, encoding, callback) {
      data += chunk.toString();
      callback();
    },
  });
  stream.isTTY = isTTY;
  stream.columns = columns;
  stream.rows = 40;
  // TTY cursor helpers used by ora when the status line redraws itself.
  stream.cursorTo = () => true;
  stream.clearLine = () => true;
  stream.moveCursor = () => true;
  stream.getData = () => data;
  return stream;
}

// ANSI sequences and carriage returns occupy no columns, so they are dropped
// before any width or layout assertion.
const strip = (text) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');

// The live region is drawn on a frame budget (one frame per ~80ms), never one
// frame per token, so a test that inspects a redraw must let a frame land.
const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 120));

test('web search fallback prints one compact provider tree, never a stack trace', () => {
  const stdout = capture({ isTTY: true, columns: 80 });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });
  renderer.webSearchStatus({
    phase: 'done',
    capability: 'search',
    ok: false,
    rows: [
      { id: 'you', label: 'You.com', status: 'failed', reason: 'timeout', durationMs: 8000 },
      { id: 'firecrawl', label: 'Firecrawl', status: 'failed', reason: 'tidak dapat dihubungi', durationMs: 120 },
      { id: 'duckduckgo', label: 'DuckDuckGo', status: 'skipped', reason: 'dinonaktifkan' },
      { id: 'tavily', label: 'Tavily', status: 'skipped', reason: 'API key belum dikonfigurasi' },
    ],
  });
  const text = strip(stdout.getData());
  assert.match(text, /WEB SEARCH/);
  assert.match(text, /You\.com\s+✕ timeout 8000ms/);
  assert.match(text, /Firecrawl\s+✕ tidak dapat dihubungi/);
  assert.match(text, /Tavily\s+! API key belum dikonfigurasi/);
  assert.match(text, /Tidak ada provider yang berhasil/);
  assert.ok(!text.includes('    at '), 'no stack trace may reach the terminal');
});

test('live reasoning shows a five-line preview inside a closed, symmetric box', async () => {
  const stdout = capture({ isTTY: true, columns: 60 });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });

  renderer.reasoningDelta({ text: 'first thought about the fix\nsecond thought about tests' });
  let output = stdout.getData();
  assert.match(output, /reasoning stream #\d+/);
  assert.match(output, /live/);
  assert.match(output, /second thought/);

  const visible = strip(output);
  const lines = visible.split('\n');
  const header = lines.find((line) => line.includes('reasoning stream'));
  const bottom = lines.find((line) => line.startsWith('  ╰'));
  assert.ok(header, 'the box header must be drawn while reasoning');
  assert.ok(bottom, 'the box must already be closed while reasoning is streaming');
  assert.equal(header.length, bottom.length, 'header and bottom border must be the same width');
  assert.equal(lines.filter((line) => line.includes('│')).length, 5, 'preview must show five rows');

  renderer.reasoningDelta({ text: ' and more' });
  await nextFrame();
  assert.match(strip(stdout.getData()), /and more/);

  const blockId = renderer.listBlocks()[0].id;
  const before = stdout.getData().length;
  renderer.reasoningEnd({ logFile: '/tmp/reasoning.log' });
  const visibleTail = strip(stdout.getData().slice(before)).replace(/\r/g, '');
  assert.match(visibleTail, /reasoning stream #\d+/, 'the 5-row preview is kept as the step record');
  assert.match(visibleTail, /reasoning \d+ chars/);
  assert.match(visibleTail, new RegExp(`click or /expand ${blockId}`));
  assert.ok(!visibleTail.includes('/tmp/reasoning.log'), 'the reasoning log path must not be printed');

  const block = renderer.listBlocks()[0];
  assert.match(block.text, /first thought about the fix/);
  assert.match(block.text, /and more/);

  const beforeOpen = stdout.getData().length;
  assert.equal(renderer.openBlockView(blockId), true);
  const opened = strip(stdout.getData().slice(beforeOpen));
  assert.match(opened, new RegExp(`reasoning #${blockId}`));
  assert.match(opened, /first thought about the fix/);
  assert.match(opened, /and more/);
  assert.match(opened, /Esc or click to close/);

  const beforeClose = stdout.getData().length;
  assert.equal(renderer.closeBlockView(), true);
  assert.ok(/\x1b\[[0-9]+A/.test(stdout.getData().slice(beforeClose)), 'closing reclaims the panel rows');
});

test('each reasoning pass keeps its own block and full text', () => {
  const stdout = capture({ isTTY: true, columns: 60 });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });

  renderer.reasoningDelta({ text: 'alpha one\nbeta two' });
  renderer.reasoningEnd({});
  renderer.reasoningDelta({ text: 'gamma three\ndelta four' });
  renderer.reasoningEnd({});

  const blocks = renderer.listBlocks();
  assert.equal(blocks.length, 2);
  assert.notEqual(blocks[0].id, blocks[1].id);
  assert.match(blocks[0].text, /alpha one/);
  assert.match(blocks[1].text, /gamma three/);
  assert.ok(!blocks[1].text.includes('alpha one'), 'the newer block must not inherit the older text');

  const beforeFirst = stdout.getData().length;
  renderer.openBlockView(blocks[0].id);
  assert.match(strip(stdout.getData().slice(beforeFirst)), /alpha one/);

  const beforeSecond = stdout.getData().length;
  renderer.openBlockView(blocks[1].id);
  const second = strip(stdout.getData().slice(beforeSecond));
  assert.match(second, /gamma three/);
  assert.ok(!second.includes('alpha one'), 'opening another block must not leave the old content behind');

  const beforeClose = stdout.getData().length;
  assert.equal(renderer.closeBlockView(), true);
  assert.ok(/\x1b\[[0-9]+A/.test(stdout.getData().slice(beforeClose)));
});

test('run_command output prints a closed block that expands to the full log on click', () => {
  const stdout = capture({ isTTY: true, columns: 70 });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });
  let repaints = 0;
  renderer.setPromptController({
    metrics: () => ({ active: true, rows: 1, cursorRow: 0 }),
    repaint: () => {
      repaints += 1;
    },
  });

  renderer.toolEnd({ name: 'run_command', ok: true, durationMs: 120, summary: 'exit 0' });
  const output = Array.from({ length: 9 }, (_, index) => `out-${index + 1}`).join('\n');
  renderer.commandOutput({
    argv: ['npm', 'test'],
    stdout: `${output}\n`,
    exitCode: 0,
    status: 'exited',
    processId: 'p1',
  });

  const text = strip(stdout.getData());
  assert.match(text, /\$ npm test/);
  assert.match(text, /⌘ run_command #\d+ · exit 0/);
  assert.match(text, /out-9/);
  assert.ok(!text.includes('out-4'), 'the preview keeps only the last five lines');
  assert.match(text, /4 more line\(s\)/);
  assert.match(text, /click or \/expand \d+/);
  assert.match(text, /\/logs p1/);
  const lines = text.split('\n');
  const header = lines.find((line) => line.includes('⌘ run_command'));
  const bottom = lines.filter((line) => line.startsWith('  ╰')).pop();
  assert.ok(header && bottom, 'the command output must live in a closed box');
  assert.equal(header.length, bottom.length, 'header and bottom border must match in width');

  const blockId = renderer.listBlocks()[0].id;
  const headerRow = lines.findIndex((line) => line.includes('⌘ run_command'));
  const beforeExpand = stdout.getData().length;
  // Every write restores the prompt; count only the panel's own repaints.
  repaints = 0;
  assert.equal(renderer.handleMouse({ button: 0, x: 2, y: headerRow + 1, release: false }), true);
  const expanded = stdout.getData().slice(beforeExpand);
  const expandedVisible = strip(expanded);
  assert.match(expandedVisible, new RegExp(`run_command #${blockId}`));
  assert.match(expandedVisible, /out-1/);
  assert.match(expandedVisible, /out-4/);
  assert.match(expandedVisible, /Esc or click to close/);
  assert.equal(repaints, 1, 'the prompt is restored below the panel');

  const beforeClose = stdout.getData().length;
  assert.equal(renderer.handleMouse({ button: 0, x: 2, y: headerRow + 1, release: false }), true);
  assert.ok(/\x1b\[[0-9]+A/.test(stdout.getData().slice(beforeClose)), 'clicking the block again closes it');
  assert.equal(renderer.isBlockViewOpen(), false);
  assert.equal(repaints, 2);
});

test('a long command block scrolls inside its panel', () => {
  const stdout = capture({ isTTY: true, columns: 70 });
  stdout.rows = 12;
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });

  const output = Array.from({ length: 40 }, (_, index) => `row ${index + 1}`).join('\n');
  renderer.commandOutput({ argv: ['seq', '40'], stdout: output, exitCode: 0 });
  const blockId = renderer.listBlocks()[0].id;

  const beforeOpen = stdout.getData().length;
  assert.equal(renderer.openBlockView(blockId), true);
  const panel = strip(stdout.getData().slice(beforeOpen));
  assert.match(panel, /row 1/);
  assert.ok(!panel.includes('row 40'), 'only a viewport of the long log is visible');
  assert.match(panel, /↑↓\/PgUp\/PgDn\/wheel/);

  const beforeEnd = stdout.getData().length;
  assert.equal(renderer.handleBlockViewKey('end'), true);
  const tailPanel = strip(stdout.getData().slice(beforeEnd));
  assert.match(tailPanel, /row 40/);
  assert.ok(!tailPanel.includes('row 1\n'), 'scrolling to the end hides the head of the log');
});

test('old command blocks stay expandable after later commands ran', () => {
  const stdout = capture({ isTTY: true, columns: 70 });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });

  renderer.commandOutput({ argv: ['ls'], stdout: 'file-a\nfile-b\n', exitCode: 0, processId: 'p1' });
  renderer.commandOutput({ argv: ['pwd'], stdout: '/tmp/project\n', exitCode: 0, processId: 'p2' });
  renderer.success('next step started');

  const blocks = renderer.listBlocks();
  assert.equal(blocks.length, 2);
  assert.match(renderer.blockListText(), /#1[\s\S]*run_command[\s\S]*#2/);

  const before = stdout.getData().length;
  assert.equal(renderer.openBlockView(blocks[0].id), true);
  const opened = strip(stdout.getData().slice(before));
  assert.match(opened, /file-a/);
  assert.match(opened, /file-b/);
  assert.ok(!opened.includes('/tmp/project'), 'only the requested block is shown');
  assert.equal(renderer.closeBlockView(), true);
});

test('plain mode prints the command and a bounded output tail', () => {
  const stdout = capture({ isTTY: false });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: true, color: false });

  const output = Array.from({ length: 30 }, (_, index) => `row-${index + 1}`).join('\n');
  renderer.commandOutput({ argv: ['ls'], stdout: output, exitCode: 2, processId: 'p2' });

  const text = stdout.getData();
  assert.match(text, /^  \$ ls$/m);
  assert.match(text, /row-30/);
  assert.ok(!text.split('\n').some((line) => line.trim() === 'row-1'), 'only the tail is printed');
  assert.match(text, /10 more line\(s\) · \/logs p2/);

  const block = renderer.listBlocks()[0];
  assert.ok(block, 'plain mode still records the block for /expand');
  const before = stdout.getData().length;
  assert.equal(renderer.openBlockView(block.id), true);
  const expanded = stdout.getData().slice(before);
  assert.match(expanded, /row-1/);
  assert.match(expanded, /row-30/);
});

test('reasoning stays silent during streaming in plain mode and logs a summary', () => {
  const stdout = capture({ isTTY: false });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: true, color: false });

  renderer.reasoningDelta({ text: 'private intermediate thought' });
  assert.equal(stdout.getData(), '');
  renderer.reasoningEnd({ logFile: '/tmp/reasoning.log' });
  const output = stdout.getData();
  assert.ok(!output.includes('private intermediate thought'));
  assert.match(output, /reasoning \d+ chars/);
  assert.ok(!output.includes('/tmp/reasoning.log'), 'the reasoning log path must not be printed');

  const block = renderer.listBlocks()[0];
  assert.ok(block, 'plain mode keeps the reasoning text for /expand');
  const before = stdout.getData().length;
  assert.equal(renderer.openBlockView(block.id), true);
  assert.match(stdout.getData().slice(before), /private intermediate thought/);
});

test('final-answer text streams directly as plain text, without a box', () => {
  const stdout = capture({ isTTY: true, columns: 60 });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });

  renderer.taskStart({ task: 'answer me', sessionId: 'sess-1', maxSteps: null });
  const before = stdout.getData().length;
  renderer.contentDelta({ text: 'Here is the ' });
  renderer.contentDelta({ text: 'conclusion being typed.\nSecond line of the answer.' });

  const streamed = strip(stdout.getData().slice(before));
  assert.match(streamed, /Here is the conclusion being typed\./);
  assert.ok(!streamed.includes('│'), 'the answer must not be wrapped in a box');
  assert.ok(!streamed.includes('╭') && !streamed.includes('╰'), 'no borders around the streamed answer');
  assert.equal(renderer.streamedResponse(), true, 'the streamed answer must be reported as streamed');

  const beforeFinal = stdout.getData().length;
  renderer.final({
    status: 'completed',
    steps: 1,
    durationMs: 400,
    finalText: 'Here is the conclusion being typed.\nSecond line of the answer.',
    changedFiles: [],
    commands: [],
    tests: [],
    runningProcesses: [],
    tokenUsage: { prompt: 3, completion: 4, total: 7 },
    approvals: { approved: 0, denied: 0 },
    issues: [],
    undoCount: 0,
    logFile: null,
  });
  const rawTail = stdout.getData().slice(beforeFinal);
  const tail = strip(rawTail);
  assert.ok(!/\x1b\[[0-9]+A/.test(rawTail), 'plain streamed text is never reclaimed');
  assert.equal(tail.includes('Here is the conclusion'), false, 'the streamed answer must not be printed twice');
  assert.match(tail, /Second line of the answer\./, 'the trailing partial line is flushed when the run ends');
  assert.match(tail, /summary/);

  renderer.taskStart({ task: 'next task', sessionId: 'sess-2', maxSteps: null });
  assert.equal(renderer.streamedResponse(), false, 'a new task starts with empty streaming memory');
});

test('streamed answer renders inline Markdown so bold markers never leak', () => {
  const stdout = capture({ isTTY: true, columns: 80 });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });

  renderer.contentDelta({ text: 'Halo! Nama saya **Ryuu**, model **GLM** dari **Z.ai**.\n' });
  renderer.contentDelta({ text: 'Pakai `node` dan *italic* juga.\n' });

  const raw = stdout.getData();
  const visible = strip(raw);
  assert.ok(!visible.includes('**'), 'bold markers must not leak into the terminal');
  assert.match(visible, /Nama saya Ryuu, model GLM dari Z\.ai\./);
  assert.match(visible, /Pakai node dan italic juga\./);
  assert.match(raw, /\x1b\[1m/, 'bold text must be painted bold');
});

test('model template control tokens are stripped from every surface', () => {
  const stdout = capture({ isTTY: true, columns: 80 });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });

  renderer.reasoningDelta({ text: '<|channel>thought\ninner reasoning' });
  renderer.reasoningEnd({});
  renderer.contentDelta({ text: '<|channel>thought\nSaya adalah **Gemma**.<channel|>\n' });
  renderer.plan({ plan: '<|channel>thought\n1. jawab' });
  renderer.note({ text: '<start_of_turn>model hello' });

  const out = stdout.getData();
  assert.ok(!out.includes('<|channel>'), 'opening control tokens must be stripped');
  assert.ok(!out.includes('<channel|>'), 'closing control tokens must be stripped');
  assert.ok(!out.includes('<start_of_turn>'), 'turn markers must be stripped');
  assert.match(strip(out), /inner reasoning/);
  assert.match(strip(out), /Saya adalah Gemma/);
  assert.match(strip(out), /jawab/);
});

test('other output never splits the streamed answer mid-line', () => {
  const stdout = capture({ isTTY: true, columns: 80 });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });

  renderer.contentDelta({ text: 'Kalimat yang belum selesai di proyek' }); // stays pending
  renderer.plan({ plan: '1. inspect\n2. fix' }); // other output: must flush first

  const out = strip(stdout.getData());
  const answerAt = out.indexOf('Kalimat yang belum selesai di proyek');
  const planAt = out.indexOf('PLAN');
  assert.ok(answerAt !== -1, 'the pending answer line must be flushed');
  assert.ok(answerAt < planAt, 'the answer line must be printed before the plan block, never after it');
});

test('streamed ATX headers render as bold text without hash marks', () => {
  const stdout = capture({ isTTY: true, columns: 80 });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });

  renderer.contentDelta({ text: '### 1. Overview Proyek\nIni penjelasan biasa.\n' });
  const raw = stdout.getData();
  assert.ok(!strip(raw).includes('###'), 'hash marks must not leak into the terminal');
  assert.match(strip(raw), /1\. Overview Proyek/);
  assert.match(raw, /\x1b\[1m/, 'the header line must render bold');
});

test('streamed tables and code fences render as blocks, never raw pipes', () => {
  const stdout = capture({ isTTY: true, columns: 80 });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });

  renderer.contentDelta({ text: '| Folder | Stack |\n|---|---|\n| api | Express |\n\n' });
  renderer.contentDelta({ text: '```js\nconst x = 1;\n```\nSelesai.\n' });
  const visible = strip(stdout.getData());
  assert.ok(!visible.includes('|---|'), 'the raw separator row must not leak');
  assert.ok(!visible.includes('```'), 'code fences must be consumed by the renderer');
  assert.match(visible, /Folder/);
  assert.match(visible, /Express/);
  assert.match(visible, /const x = 1;/);
  assert.match(visible, /Selesai\./);
});

test('a table row wider than the screen streams as one block, never fragmented', () => {
  const stdout = capture({ isTTY: true, columns: 60 });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });

  // The exact failure from the field: a long row was wrapped BEFORE table
  // detection, so the continuation lines closed the table early and the rest
  // of the row leaked as raw pipe text after the closing border.
  const wideRow =
    '| api/ | Node.js (Express), React/Vite SPA | Backend REST API utama ' +
    '(nama paket Haruka v3.0.0). Mengelola sesi, file upload, proxy, ' +
    'cron job, dan WebSocket. |';
  renderer.contentDelta({ text: `| Folder | Teknologi | Deskripsi singkat |\n|---|---|---|\n${wideRow}\n` });
  renderer.answerEnd({}); // the stream ends; the open table block must render

  const visible = strip(stdout.getData());
  assert.equal((visible.match(/╭/g) || []).length, 1, 'exactly one table must be rendered, no fragments');
  const closeAt = visible.lastIndexOf('╰');
  assert.ok(closeAt !== -1, 'the table must be closed by its bottom border');
  assert.ok(
    !visible.slice(closeAt).includes('|'),
    'no raw table fragment may leak after the closing border',
  );
  assert.match(visible, /Haruka/, 'the wide cell content must survive, wrapped inside the table');
});

test('horizontal rules render as dividers and blockquotes lose their marker', () => {
  const stdout = capture({ isTTY: true, columns: 80 });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });

  renderer.contentDelta({ text: 'Sebelum.\n---\n>   3. Data diambil dari API.\nSesudah.\n' });
  const visible = strip(stdout.getData());
  assert.ok(!visible.includes('---'), 'raw dashes must not leak');
  assert.ok(!visible.includes('>'), 'the blockquote marker must not leak');
  assert.match(visible, /─/, 'the rule renders as a divider line');
  assert.match(visible, /3\. Data diambil dari API\./);
  assert.match(visible, /Sebelum\./);
  assert.match(visible, /Sesudah\./);
});

test('long lines wrap without splitting bold spans or leaving stray asterisks', () => {
  const stdout = capture({ isTTY: true, columns: 60 });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });

  const filler = 'kata '.repeat(20);
  renderer.contentDelta({ text: `${filler}**penting sekali** ${filler}\n` });
  const visible = strip(stdout.getData());
  assert.ok(!visible.includes('*'), 'no stray asterisk may survive the wrap');
  assert.match(visible, /penting sekali/);
});

test('a streamed answer is plain text: never erased, never repeated', () => {
  const stdout = capture({ isTTY: true, columns: 60 });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });

  renderer.contentDelta({ text: 'Answer written while a plan was printed below.' });
  renderer.plan({ plan: '1. inspect\n2. fix' }); // interleaves below the streamed text

  const before = stdout.getData().length;
  renderer.final({
    status: 'completed',
    steps: 1,
    durationMs: 200,
    finalText: 'Answer written while a plan was printed below.',
    changedFiles: [],
    commands: [],
    tests: [],
    runningProcesses: [],
    tokenUsage: { prompt: 1, completion: 1, total: 2 },
    approvals: { approved: 0, denied: 0 },
    issues: [],
    undoCount: 0,
    logFile: null,
  });
  const rawTail = stdout.getData().slice(before);
  const tail = strip(rawTail);
  assert.ok(!/\x1b\[[0-9]+A/.test(rawTail), 'plain streamed text is never reclaimed');
  const whole = strip(stdout.getData());
  assert.equal(
    whole.split('Answer written while a plan was printed below.').length - 1,
    1,
    'the streamed answer must appear exactly once, never repeated in the summary',
  );
  assert.match(tail, /summary/);
});

test('TTY banner renders the HUD and the prompt uses ryuu', () => {
  const stdout = capture({ isTTY: true, columns: 100 });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });
  renderer.banner({
    version: '0.1.0',
    model: 'test/model',
    provider: 'NVIDIA Integrate API',
    workspace: '/tmp/fixture',
    node: 'v25.9.0',
    approvalPolicy: 'ask',
    logFile: '/tmp/fixture/.ryuu/logs/agent.log',
  });
  const output = stdout.getData();
  const visible = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  assert.match(visible, /RYUU \/\/ AGENT OS/);
  assert.match(visible, /██████╗/);
  assert.match(visible, /autonomous coding intelligence/);
  assert.match(output, /TELEMETRY/);
  assert.match(output, /workspace/);
  assert.match(output, /test\/model/);
  assert.match(renderer.prompt().replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''), /ryuu/);

  const narrowStdout = capture({ isTTY: true, columns: 60 });
  const narrowRenderer = new Renderer({ stdout: narrowStdout, stderr: narrowStdout, plain: false, color: true });
  narrowRenderer.banner({
    version: '0.1.0',
    model: 'test/model',
    provider: 'NVIDIA Integrate API',
    workspace: '/tmp/fixture',
    node: 'v25.9.0',
    approvalPolicy: 'ask',
    logFile: null,
  });
  const narrow = narrowStdout.getData().replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  assert.match(narrow, /██████╗/);
  assert.ok(narrow.split('\n').every((line) => line.length <= 60));

  const plain = capture({ isTTY: false });
  const plainRenderer = new Renderer({ stdout: plain, stderr: plain, plain: true, color: false });
  assert.equal(plainRenderer.prompt(), 'ryuu> ');
});

test('final answer renders Markdown tables and code blocks', () => {
  const stdout = capture({ isTTY: true, columns: 100 });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: false });
  renderer.final({
    status: 'completed',
    steps: 2,
    durationMs: 1200,
    finalText: [
      '**Done** — the parser is shared.',
      '',
      '| File | Status |',
      '|---|---|',
      '| src/auth.js | updated |',
      '',
      '```js',
      'const answer = 42;',
      '```',
    ].join('\n'),
    changedFiles: ['src/auth.js'],
    commands: [],
    tests: [],
    runningProcesses: [],
    tokenUsage: { prompt: 10, completion: 5, total: 15 },
    approvals: { approved: 1, denied: 0 },
    issues: [],
    undoCount: 1,
    logFile: null,
  });
  const output = stdout.getData();
  assert.match(output, /RESPONSE/);
  assert.match(output, /╭/);
  assert.match(output, /const answer = 42;/);
  assert.ok(!output.includes('**Done**'));
  assert.ok(!output.includes('```'));
});

test('ending reasoning reclaims the live viewport and keeps the block for later', async () => {
  const stdout = capture({ isTTY: true, columns: 80 });
  stdout.rows = 40;
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });

  renderer.reasoningDelta({ text: 'baris satu\nbaris dua\nbaris tiga' });
  const before = stdout.getData().length;
  renderer.reasoningEnd({});
  renderer.contentDelta({ text: 'Jawaban setelah reasoning penuh.\n' });
  renderer.answerEnd();

  const tail = stdout.getData().slice(before);
  assert.ok(/\x1b\[[0-9]+A/.test(tail), 'the live viewport must be erased when reasoning ends');
  assert.ok(
    strip(tail).indexOf('Jawaban setelah reasoning penuh.') >= 0,
    'the answer must follow directly in the reclaimed space',
  );

  const block = renderer.listBlocks()[0];
  const beforeOpen = stdout.getData().length;
  renderer.openBlockView(block.id);
  const opened = strip(stdout.getData().slice(beforeOpen));
  assert.match(opened, /baris satu/);
  assert.match(opened, /baris tiga/);
});

test('a long reasoning pass is coalesced into a few frames, not one per token', async () => {
  const stdout = capture({ isTTY: true, columns: 100 });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });

  // The field failure: every streamed token redrew the whole box, pushing
  // megabytes through the terminal (and over SSH) for a single reasoning pass.
  for (let index = 0; index < 400; index += 1) renderer.reasoningDelta({ text: `token${index} ` });
  await nextFrame();

  const output = stdout.getData();
  const frames = (output.match(/◈ reasoning stream/g) || []).length;
  assert.ok(frames >= 1 && frames < 20, `400 tokens must not draw 400 boxes (drew ${frames})`);
  assert.ok(output.length < 120_000, `frame output must stay bounded (got ${output.length} bytes)`);
  assert.match(strip(output), /token399/, 'the newest token still reaches the screen');
});

test('wide-character reasoning keeps every box row inside the terminal width', () => {
  const stdout = capture({ isTTY: true, columns: 60 });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });

  // Counting characters instead of columns made CJK/emoji rows wrap, so the
  // cursor-up erase walked the wrong number of rows and scrolled the screen.
  renderer.reasoningDelta({ text: '中文推理 reasoning 🚀 emoji 思考 alur\n'.repeat(6) });
  const visible = strip(stdout.getData()).split('\n').map((line) => line.replace(/\r/g, ''));
  const rows = visible.filter((line) => line.includes('│') || line.includes('╭') || line.includes('╰'));
  assert.ok(rows.length >= 7, 'the box must be drawn');
  const widthOf = (line) =>
    [...line].reduce((total, char) => {
      const code = char.codePointAt(0);
      const wide = /[\u2E80-\u9FFF\u3041-\u33FF\uFF00-\uFF60\u{1F300}-\u{1FAFF}]/u.test(char);
      return total + (wide ? 2 : 1) + (code >= 0x300 && code <= 0x36f ? -1 : 0);
    }, 0);
  const widths = new Set(rows.map(widthOf));
  assert.equal(widths.size, 1, `every box row must be exactly one terminal line wide (saw ${[...widths].join(', ')})`);
  assert.equal([...widths][0], 58, 'the box must fill the clamped 58-column width');
});

test('one always-on activity line animates thinking → reasoning → working', async () => {
  const stdout = capture({ isTTY: true, columns: 80 });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });

  // thinking: the model is working in the background (no visible output yet)
  renderer.thinkingStart();
  let visible = strip(stdout.getData()).replace(/\r/g, '');
  assert.match(visible, /thinking/);
  assert.match(visible, /0\.0s/);

  const firstFrame = stdout.getData().length;
  await new Promise((resolve) => setTimeout(resolve, 260));
  const animated = strip(stdout.getData().slice(firstFrame)).replace(/\r/g, '');
  assert.match(animated, /thinking/);
  assert.match(animated, /0\.[12]s/, 'the elapsed clock keeps ticking');

  // reasoning: the activity line sits under the reasoning box, same phase name
  renderer.reasoningDelta({ text: 'berpikir tentang renderer' });
  visible = strip(stdout.getData()).replace(/\r/g, '');
  assert.match(visible, /reasoning stream/);
  assert.ok(renderer.liveLines >= 7, 'five box rows + borders + the activity line');

  // working: fallback when the model assembles/runs a system action
  renderer.reasoningEnd({});
  renderer.workingStart({ tool: 'run_command' });
  visible = strip(stdout.getData()).replace(/\r/g, '');
  assert.match(visible, /working/);
  assert.match(visible, /run_command/);

  renderer.stopActivity();
  assert.equal(renderer.status.active, false);
  assert.equal(renderer.status.timer, null, 'the animation ticker must be cleared');
  assert.equal(renderer.liveLines, 0);
  assert.match(stdout.getData().slice(-200), /\x1b\[(2K|0J)/, 'the line is cleared when the task ends');
});

test('expanding an unknown or empty block is a no-op', () => {
  const stdout = capture({ isTTY: true });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });
  assert.equal(renderer.openBlockView(42), false);
  assert.equal(renderer.closeBlockView(), false);
  assert.equal(renderer.handleMouse({ button: 0, x: 1, y: 1, release: false }), false);
  assert.equal(stdout.getData(), '');
});

test('the heartbeat shows a reconnect attempt and keeps the activity line alive', async () => {
  const stdout = capture({ isTTY: true, columns: 80 });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });

  renderer.thinkingStart();
  renderer.heartbeat({ phase: 'retry', attempt: 2, maxAttempts: 5, delayMs: 1500, code: 'PROVIDER_NETWORK' });
  const visible = strip(stdout.getData()).replace(/\r/g, '');
  assert.match(visible, /heartbeat/);
  assert.match(visible, /reconnecting/);
  assert.match(visible, /attempt 2\/5/);
  assert.match(visible, /1\.5s/);
  assert.match(visible, /PROVIDER_NETWORK/);
  assert.equal(renderer.status.phase, 'reconnecting', 'the activity line must show the reconnect phase');

  const mark = stdout.getData().length;
  await new Promise((resolve) => setTimeout(resolve, 260));
  const animated = strip(stdout.getData().slice(mark)).replace(/\r/g, '');
  assert.match(animated, /reconnecting/, 'the heartbeat must keep beating while it waits');

  renderer.heartbeat({ phase: 'restored', attempt: 2, maxAttempts: 5 });
  const restored = strip(stdout.getData()).replace(/\r/g, '');
  assert.match(restored, /link restored/);
  assert.equal(renderer.status.phase, 'working');

  renderer.stopActivity();
});

test('an empty-response retry heartbeat says the attempt count is unlimited', async () => {
  const stdout = capture({ isTTY: true, columns: 80 });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });
  renderer.thinkingStart();
  renderer.heartbeat({ phase: 'retry', attempt: 3, maxAttempts: 0, delayMs: 2000, code: 'EMPTY_RESPONSE' });
  const visible = strip(stdout.getData());
  assert.match(visible, /heartbeat/);
  assert.match(visible, /empty response · attempt 3 \(unlimited\) in 2\.0s/);
  assert.doesNotMatch(visible, /attempt 3\/0/);
  assert.equal(renderer.status.phase, 'retrying');
  renderer.stopActivity();
});

test('the heartbeat reports a repaired model response in plain mode', () => {
  const stdout = capture({ isTTY: false });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: true, color: false });
  renderer.heartbeat({ phase: 'degraded', code: 'ARGUMENTS_REPAIRED', message: 'read_file: truncated arguments repaired' });
  const visible = strip(stdout.getData()).replace(/\r/g, '');
  assert.match(visible, /heartbeat/);
  assert.match(visible, /ARGUMENTS_REPAIRED/);
  assert.match(visible, /truncated arguments repaired/);
});

test('the activity line carries step, total time, tool progress and token telemetry', () => {
  const stdout = capture({ isTTY: true, columns: 140 });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });

  renderer.taskStart({ task: 'fix it', sessionId: 'sess-1', maxSteps: null });
  renderer.thinkingStart({ step: 3 });
  renderer.progress({ step: 3, promptTokens: 21300, completionTokens: 412, firstTokenMs: 1200 });
  renderer.toolStart({ name: 'edit_file', args: { path: 'src/x.js' }, index: 2, total: 5, detail: 'src/x.js' });

  const visible = strip(stdout.getData()).replace(/\r/g, '');
  assert.match(visible, /step 3/, 'the live line must name the step');
  assert.match(visible, /total \d+\.\d+s/, 'the live line must carry the total run time');
  assert.match(visible, /writing edit_file src\/x\.js \(2\/5\)/, 'the live line must say what is being written and how many calls are queued');
  assert.match(visible, /21\.3k↑ 412↓ tok/, 'live token counts must be visible while the model works');
  renderer.stopActivity();
});

test('each model call reports its latency, tokens and first-token time', () => {
  const stdout = capture({ isTTY: true, columns: 120 });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });

  renderer.thinkingStart({ step: 1 });
  renderer.thinkingEnd({
    durationMs: 8200,
    firstTokenMs: 1200,
    usage: { prompt: 21300, completion: 412, total: 21712 },
    finishReason: 'length',
  });

  const visible = strip(stdout.getData()).replace(/\r/g, '');
  assert.match(visible, /model 8\.2s/);
  assert.match(visible, /21\.3k↑ 412↓ tok/);
  assert.match(visible, /first token 1\.2s/);
  assert.match(visible, /truncated at the token cap/, 'a cut-off response must be called out');
});

test('a file change is printed as a unified diff with - and + lines', () => {
  const stdout = capture({ isTTY: true, columns: 120 });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });

  const diff = [
    '--- a/src/agent/agent.js',
    '+++ b/src/agent/agent.js',
    '@@ -1,2 +1,3 @@',
    '       tokenUsage: session.tokenUsage,',
    '-      approvals: this.approvals.stats,',
    '+      metrics: {',
    '+        modelCalls: 1,',
  ].join('\n');
  renderer.fileDiff({ kind: 'edit', path: 'src/agent/agent.js', diff, added: 2, removed: 1 });

  const visible = strip(stdout.getData()).replace(/\r/g, '');
  assert.match(visible, /• Edit src\/agent\/agent\.js/);
  assert.match(visible, /\+2 −1/);
  assert.match(visible, /-      approvals: this\.approvals\.stats,/);
  assert.match(visible, /\+      metrics: \{/);
  assert.ok(!visible.includes('--- a/'), 'file headers are not diff content');
  assert.match(stdout.getData(), /\x1b\[32m/, 'added lines are painted green');
});

test('a long diff is bounded and says how many lines were hidden', () => {
  const stdout = capture({ isTTY: true, columns: 100 });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });
  const rows = ['--- a/f.js', '+++ b/f.js', '@@ -1,40 +1,40 @@'];
  for (let index = 0; index < 40; index += 1) rows.push(`+line ${index}`);
  renderer.fileDiff({ kind: 'write', path: 'f.js', diff: rows.join('\n'), added: 40, removed: 0 });
  const visible = strip(stdout.getData()).replace(/\r/g, '');
  assert.match(visible, /… \d+ more diff line\(s\)/, 'the rest must be summarised, not dumped');
  assert.ok(!visible.includes('line 39'), 'the diff must stay bounded');
});

test('command output streams into the live region while the command runs', async () => {
  const stdout = capture({ isTTY: true, columns: 100 });
  const renderer = new Renderer({ stdout, stderr: stdout, plain: false, color: true });

  renderer.thinkingStart({ step: 1 });
  renderer.processOutput({ stream: 'stdout', text: 'building...\n' });
  renderer.processOutput({ stream: 'stdout', text: 'test 1/9 ok\n' });
  await new Promise((resolve) => setTimeout(resolve, 220));

  const visible = strip(stdout.getData()).replace(/\r/g, '');
  assert.match(visible, /test 1\/9 ok/, 'stdout must be visible before the command exits');
  assert.equal(renderer.status.output.length, 2, 'the tail is bounded to two rows');
  renderer.stopActivity();
});
