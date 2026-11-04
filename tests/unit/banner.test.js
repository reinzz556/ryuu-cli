import assert from 'node:assert/strict';
import test from 'node:test';
import { Chalk } from 'chalk';

import { bannerLines, BANNER_LOGO, colorLevel, paintLogo } from '../../src/cli/banner.js';
import { displayWidth } from '../../src/cli/width.js';

const header = {
  version: '9.9.9',
  workspace: '/home/dev/a/very/long/workspace/path',
  node: 'v25.9.0',
  platform: 'linux',
  model: 'nvidia/llama-3.1',
  approvalPolicy: 'ask + --auto-approve (all actions)',
  logFile: '/home/dev/.ryuu/logs/agent.log',
};

const strip = (text) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');

test('banner values come from the header', () => {
  const text = strip(bannerLines(header, { width: 120, c: new Chalk({ level: 3 }) }).join('\n'));
  assert.match(text, /Ryuu CLI v9\.9\.9/);
  assert.match(text, /workspace/);
  assert.match(text, /Node\.js v25\.9\.0 · Linux/);
  assert.match(text, /nvidia\/llama-3\.1/);
  assert.match(text, /ask \+ --auto-approve/);
  assert.match(text, /\.ryuu\/logs\/agent\.log/);
});

test('every banner line fits the terminal width', () => {
  const c = new Chalk({ level: 3 });
  for (const width of [26, 30, 34, 39, 40, 48, 60, 80, 120]) {
    const rows = bannerLines(header, { width, c });
    for (const row of rows) {
      assert.ok(displayWidth(row, { ansi: true }) <= width, `row wider than ${width}: ${JSON.stringify(strip(row))}`);
    }
  }
});

test('truecolor terminals get a per-row gradient and a reset', () => {
  const c = new Chalk({ level: 3 });
  const rows = paintLogo(c);
  assert.equal(rows.length, BANNER_LOGO.length);
  assert.match(rows[0], /\x1b\[38;2;244;114;182m/, 'top row starts pink');
  assert.match(rows[rows.length - 1], /\x1b\[38;2;56;189;248m/, 'bottom row ends sky blue');
  const output = bannerLines(header, { width: 100, c }).join('\n');
  assert.match(output, /\x1b\[(0|39|22)m/, 'chalk closes colours and attributes');
});

test('non-truecolor terminals fall back without 24-bit sequences', () => {
  const basic = new Chalk({ level: 1 });
  assert.equal(colorLevel(basic), 1);
  const rows = paintLogo(basic);
  assert.ok(rows.every((row) => !row.includes('38;2;')), 'no truecolor escape at level 1');
  assert.ok(rows.every((row) => row.includes('\x1b[')), 'basic terminals still get a colour');

  const mono = new Chalk({ level: 0 });
  const bare = paintLogo(mono);
  assert.deepEqual(bare, BANNER_LOGO.slice(), 'level 0 emits no ANSI at all');
  assert.doesNotMatch(bannerLines(header, { width: 80, c: mono }).join('\n'), /\x1b\[/);
});

test('no colour also means no ANSI when no chalk instance is passed', () => {
  assert.doesNotMatch(bannerLines(header, { width: 80 }).join('\n'), /\x1b\[/);
});
