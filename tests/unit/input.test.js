import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  ComposerInput,
  PasteRegistry,
  formatPastePlaceholder,
} from '../../src/cli/input.js';
import { PromptSession } from '../../src/cli/prompts.js';

function composer() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const filter = new ComposerInput({ input });
  let forwarded = '';
  filter.proxy.on('data', (chunk) => {
    forwarded += chunk.toString();
  });
  filter.composing = true;
  return {
    input,
    filter,
    text: () => forwarded,
    clear: () => {
      forwarded = '';
    },
  };
}

const paste = (text) => `\x1b[200~${text}\x1b[201~`;

test('paste placeholders use the exact compact format', () => {
  assert.equal(formatPastePlaceholder(1, 3196), '> [Pasted text #1 3196 chars]');
  assert.equal(formatPastePlaceholder(12, 1000), '> [Pasted text #12 1000 chars]');
});

test('a paste under the threshold stays inline text', () => {
  const c = composer();
  const text = 'x'.repeat(999);
  c.filter.push(paste(text));
  assert.equal(c.text(), text);
});

test('a paste of exactly 1000 characters becomes one placeholder', () => {
  const c = composer();
  const text = 'y'.repeat(1000);
  c.filter.push(paste(text));
  assert.equal(c.text(), '> [Pasted text #1 1000 chars]');
  assert.equal(c.filter.registry.get(1).text, text);
});

test('a paste just over the threshold uses its real character count', () => {
  const c = composer();
  c.filter.push(paste('k'.repeat(1001)));
  assert.equal(c.text(), '> [Pasted text #1 1001 chars]');
});

test('text before and after a long paste keeps its position', () => {
  const c = composer();
  const text = 'z'.repeat(1200);
  c.filter.push('Tolong analisis kode berikut: ');
  c.filter.push(paste(text));
  c.filter.push(' dan jelaskan error-nya.');
  assert.equal(
    c.text(),
    'Tolong analisis kode berikut: > [Pasted text #1 1200 chars] dan jelaskan error-nya.',
  );
});

test('two long pastes become numbered placeholders and resolve in order', () => {
  const c = composer();
  const first = 'a'.repeat(1100);
  const second = 'b'.repeat(1500);
  c.filter.push('Analisis: ');
  c.filter.push(paste(first));
  c.filter.push(' lalu bandingkan: ');
  c.filter.push(paste(second));
  c.filter.push(' selesai.');

  assert.equal(
    c.text(),
    'Analisis: > [Pasted text #1 1100 chars] lalu bandingkan: > [Pasted text #2 1500 chars] selesai.',
  );
  const resolved = c.filter.registry.resolve(c.text());
  assert.equal(resolved, `Analisis: ${first} lalu bandingkan: ${second} selesai.`);
});

test('deleting one placeholder does not damage or renumber another', () => {
  const registry = new PasteRegistry();
  const first = registry.add('a'.repeat(1200));
  const second = registry.add('b'.repeat(1300));
  assert.equal(first.id, 1);
  assert.equal(second.id, 2);

  const edited = `awal ${second.placeholder} akhir`;
  assert.equal(registry.resolve(edited), `awal ${second.text} akhir`);
  assert.equal(registry.get(1).text, first.text, 'the deleted placeholder keeps its stored text');
});

test('resolving the same line twice never duplicates or loses content', () => {
  const registry = new PasteRegistry();
  const entry = registry.add('q'.repeat(1600));
  const line = `sebelum ${entry.placeholder} sesudah`;
  assert.equal(registry.resolve(line), registry.resolve(line));
  assert.equal(registry.resolve(line), `sebelum ${entry.text} sesudah`);
});

test('terminals without bracketed paste still collapse a large raw chunk', () => {
  const c = composer();
  const text = 'r'.repeat(1000);
  c.filter.push(text);
  assert.equal(c.text(), '> [Pasted text #1 1000 chars]');
  assert.equal(c.filter.registry.get(1).text, text);
});

test('a paste marker split across stdin chunks is still recognised', () => {
  const c = composer();
  const text = 'm'.repeat(1050);
  c.filter.push('\x1b[20');
  c.filter.push(`0~${text.slice(0, 500)}`);
  c.filter.push(`${text.slice(500)}\x1b[201`);
  c.filter.push('~');
  assert.equal(c.text(), '> [Pasted text #1 1050 chars]');
});

test('mouse reports are routed to the handler and never typed', () => {
  const c = composer();
  const events = [];
  c.filter.mouseHandler = (event) => events.push(event);

  c.filter.push('\x1b[<0;12;7M');
  c.filter.push('\x1b[<0;12;7m');
  c.filter.push('\x1b[<64;3;4M');

  assert.deepEqual(events[0], { button: 0, wheel: null, x: 12, y: 7, release: false });
  assert.deepEqual(events[1], { button: 0, wheel: null, x: 12, y: 7, release: true });
  assert.deepEqual(events[2], { button: 0, wheel: 'up', x: 3, y: 4, release: false });
  assert.equal(c.text(), '');
});

test('panel keys scroll instead of moving the readline cursor', () => {
  const c = composer();
  const keys = [];
  c.filter.overlayOpen = () => true;
  c.filter.composerEmpty = () => true;
  c.filter.overlayKeyHandler = (key) => keys.push(key);

  c.filter.push('\x1b[A');
  c.filter.push('\x1b[B');
  c.filter.push('\x1b[5~');
  c.filter.push('x');
  assert.deepEqual(keys, ['up', 'down', 'pageup']);
  assert.equal(c.text(), 'x', 'only ordinary typing reaches the line buffer');
});

test('arrow keys edit normally when the composer already has text', () => {
  const c = composer();
  const keys = [];
  c.filter.overlayOpen = () => true;
  c.filter.composerEmpty = () => false;
  c.filter.overlayKeyHandler = (key) => keys.push(key);

  c.filter.push('\x1b[A');
  c.filter.push('\x1b[6~');
  assert.deepEqual(keys, ['pagedown'], 'paging still belongs to the open panel');
  assert.equal(c.text(), '\x1b[A');
});

test('escape closes an open panel and enter closes it before submitting', async () => {
  const c = composer();
  const keys = [];
  let submits = 0;
  c.filter.overlayOpen = () => true;
  c.filter.composerEmpty = () => true;
  c.filter.overlayKeyHandler = (key) => keys.push(key);
  c.filter.beforeSubmit = () => {
    submits += 1;
  };

  c.filter.push('\x1b');
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.deepEqual(keys, ['close']);

  c.filter.push('\r');
  assert.equal(submits, 1);
  assert.equal(c.text(), '\r');
});

test('typing dismisses an open block panel before readline redraws', () => {
  const c = composer();
  let open = true;
  let dismissals = 0;
  c.filter.overlayOpen = () => open;
  c.filter.composerEmpty = () => true;
  c.filter.beforeSubmit = () => {
    dismissals += 1;
    open = false;
  };

  c.filter.push('a');
  c.filter.push('b');
  assert.equal(dismissals, 1, 'the first printable key closes the panel');
  assert.equal(c.text(), 'ab');
});

test('a long multipart paste lands in the prompt and resolves to the original text', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;

  let screen = '';
  const output = new EventEmitter();
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  output.write = (chunk) => {
    screen += chunk.toString();
    return true;
  };

  const prompts = new PromptSession({ input, output });
  try {
    const payload = 'line satu\n'.repeat(200);
    const chars = [...payload].length;
    const pending = prompts.ask('  ryuu> ');
    input.write(paste(payload));
    await new Promise((resolve) => setTimeout(resolve, 10));
    input.write('\r');

    const answer = await pending;
    assert.equal(answer, payload, 'the model must receive every pasted character');
    assert.ok(
      screen.includes(`> [Pasted text #1 ${chars} chars]`),
      'the composer only shows the placeholder',
    );
    assert.ok(!screen.includes('line satu\n'.repeat(3)), 'the raw paste never floods the composer');
  } finally {
    prompts.close();
  }
});

function session() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const output = new EventEmitter();
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  output.write = () => true;
  return { input, output, prompts: new PromptSession({ input, output }) };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test('lines typed between questions are queued, never dropped', async () => {
  const { input, prompts } = session();
  try {
    const first = prompts.ask('  ryuu> ');
    input.write('one\r');
    assert.equal(await first, 'one');

    // The composer stays armed even when the REPL is busy (e.g. running a
    // command), so the next line is kept until ask() collects it.
    input.write('two\r');
    await tick();
    assert.equal(await prompts.ask('  ryuu> '), 'two');
  } finally {
    prompts.close();
  }
});

test('a line typed during an approval answers the approval, not the REPL', async () => {
  const { input, prompts } = session();
  try {
    const task = prompts.ask('  ryuu> ');
    const approval = prompts.confirm('  Approve? [y/N/a] ');
    input.write('y\r');
    const answer = await approval;
    assert.equal(answer.value, true);

    input.write('/status\r');
    assert.equal(await task, '/status', 'the REPL is still waiting for its own line');
  } finally {
    prompts.close();
  }
});

test('closing the session unblocks a waiting question', async () => {
  const { prompts } = session();
  const pending = prompts.ask('  ryuu> ');
  prompts.close();
  assert.equal(await pending, null);
});

test('disposing the composer pauses stdin so the process can exit', () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  let paused = false;
  input.pause = () => {
    paused = true;
    return input;
  };
  const filter = new ComposerInput({ input });
  filter.dispose();
  assert.equal(paused, true, 'the data listener resumed stdin; dispose must pause it again');
});

test('closing the prompt session pauses stdin after /exit', () => {
  let paused = false;
  const input = new PassThrough();
  input.isTTY = false;
  input.pause = () => {
    paused = true;
    return input;
  };
  const output = new PassThrough();
  const prompts = new PromptSession({ input, output });
  prompts.close();
  assert.equal(paused, true, 'the line interface must release stdin on close');
});

test('short pastes and plain typing still reach the prompt unchanged', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;

  const output = new EventEmitter();
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  output.write = () => true;

  const prompts = new PromptSession({ input, output });
  try {
    const pending = prompts.ask('  ryuu> ');
    input.write('halo ');
    input.write(paste('dunia'));
    input.write('\r');
    assert.equal(await pending, 'halo dunia');
  } finally {
    prompts.close();
  }
});
