import test from 'node:test';
import assert from 'node:assert/strict';
import { Chalk } from 'chalk';
import { renderMarkdown } from '../../src/cli/markdown.js';

const strip = (text) => String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
const visible = (lines) => lines.map((line) => strip(line));

test('renders bold, italic, inline code, strikethrough and links', () => {
  const c = new Chalk({ level: 1 });
  const output = renderMarkdown(
    '**bold** and *italic* and `code` and ~~gone~~ and [docs](https://example.com)',
    { width: 120, c, color: true },
  );
  const text = strip(output.join('\n'));
  assert.match(text, /bold and italic and code and gone and docs/);
  assert.match(text, /\(https:\/\/example\.com\)/);
  assert.ok(!text.includes('**'));
  assert.ok(!text.includes('`code`'));
  assert.match(output.join('\n'), /\x1b\[1m/);
  assert.match(output.join('\n'), /\x1b\[3m/);
});

test('renders headings, lists, quotes and horizontal rules', () => {
  const markdown = [
    '# Report',
    '',
    '- first item',
    '- second item with **weight**',
    '',
    '1. ordered item',
    '',
    '> quoted line',
    '',
    '---',
  ].join('\n');
  const output = visible(renderMarkdown(markdown, { width: 40, color: false }));
  assert.match(output[0], /◆ Report/);
  assert.ok(output.some((line) => line.includes('▸ first item')));
  assert.ok(output.some((line) => line.includes('1. ordered item')));
  assert.ok(output.some((line) => line.includes('│ quoted line')));
  assert.ok(output.some((line) => /^─+$/.test(line)));
});

test('renders fenced code blocks and wraps long code lines to the width', () => {
  const markdown = ['```js', 'const value = "a very long string that needs wrapping";', '```'].join('\n');
  const output = renderMarkdown(markdown, { width: 30, color: false });
  assert.match(output[0], /^╭─ js/);
  assert.match(output[output.length - 1], /^╰/);
  assert.ok(output.some((line) => line.includes('const value')));
  assert.ok(output.every((line) => line.length <= 30), 'code block lines must fit the width');
});

test('a fenced code block carries a copy chip and reports its rendered row range', () => {
  const blocks = [];
  const markdown = ['before', '', '```js', 'const value = 1;', '```', '', 'after'].join('\n');
  const output = renderMarkdown(markdown, {
    width: 40,
    color: false,
    onCodeBlock: (info) => blocks.push(info),
  });
  const header = output.findIndex((line) => line.includes('⧉ copy'));
  assert.ok(header >= 0, 'the code header shows a copy chip');
  assert.equal(blocks.length, 1, 'one collector entry per fenced block');
  assert.equal(blocks[0].lang, 'js');
  assert.equal(blocks[0].code, 'const value = 1;', 'the copied text is the code, without fences');
  assert.equal(blocks[0].start, header);
  assert.ok(blocks[0].end >= header + 2, 'the range covers the whole block');
  assert.match(output[blocks[0].end], /^╰/);
  assert.ok(output.every((line) => line.length <= 40), 'the chip still fits the width');

  const withoutChip = renderMarkdown('```\nx\n```', { width: 40, color: false, copy: false });
  assert.ok(!withoutChip.join('\n').includes('⧉ copy'), 'the chip can be switched off');
});

test('tables shrink and wrap to the available width', () => {
  const markdown = [
    '| File | Status | Notes |',
    '|:-----|:------:|------:|',
    '| src/auth/token.js | in progress | Extract the shared parser |',
    '| src/auth.js | done | Removed duplicate logic |',
  ].join('\n');
  for (const width of [60, 40]) {
    const output = renderMarkdown(markdown, { width, color: false });
    const lines = visible(output);
    assert.ok(lines.every((line) => line.length <= width), `table must fit width ${width}`);
    assert.match(lines[0], /^╭/);
    assert.match(lines[lines.length - 1], /^╰/);
    const joined = lines.join('\n');
    assert.match(joined, /File/);
    assert.match(joined, /Status/);
    assert.match(joined, /src\/auth/);
    assert.match(joined, /token/);
  }
});

test('uses a vertical layout when the table cannot fit horizontally', () => {
  const markdown = [
    '| Name | Status | Notes |',
    '|---|---|---|',
    '| one | two | three |',
  ].join('\n');
  const output = visible(renderMarkdown(markdown, { width: 16, color: false }));
  assert.ok(output.every((line) => line.length <= 16), 'vertical fallback must fit the width');
  assert.ok(output.some((line) => line.includes('Name')));
});

test('long links and unbroken tokens stay inside the width', () => {
  const output = renderMarkdown('[docs](https://example.com/a/very/long/path/that/keeps/going)', {
    width: 20,
    color: false,
  });
  assert.ok(output.every((line) => line.length <= 20));
  assert.match(output.join(''), /https:\/\/example\.com/);
});

test('plain rendering strips Markdown markers and ANSI styles', () => {
  const output = renderMarkdown('**bold** and `code`', { width: 40, color: false });
  const text = output.join('\n');
  assert.equal(text, 'bold and code');
  assert.ok(!text.includes('\x1b'));
});
