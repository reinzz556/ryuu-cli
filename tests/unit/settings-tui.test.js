import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { SettingsStore } from '../../src/config/settings.js';
import { buildSettingsRegistry } from '../../src/config/settings-registry.js';
import { SettingsTui } from '../../src/cli/settings-tui.js';
import { buildProviders } from '../../src/providers/catalog.js';
import { makeTempDir } from '../helpers.js';

async function makeTui(initial = {}, { columns = 90, rows = 24 } = {}) {
  const dir = await makeTempDir('ryuu-settings-tui-');
  const file = path.join(dir, 'config.json');
  const store = new SettingsStore({ file });
  await store.save({ version: 1, ...initial });
  const { data } = await store.read();
  const providers = buildProviders({ env: {}, extras: [] });
  const makeRegistry = (current) => buildSettingsRegistry({ providers, settings: current, env: {} });
  const input = new PassThrough();
  input.isTTY = true;
  input.raw = null;
  input.setRawMode = (mode) => {
    input.raw = mode;
  };
  const writes = [];
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = columns;
  output.rows = rows;
  output.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  const tui = new SettingsTui({
    input,
    output,
    store,
    makeRegistry,
    data,
    version: '0.3.0',
    color: false,
  });
  return { tui, input, output, writes, store, file, makeRegistry };
}

function numberOf(tui, label) {
  const index = tui.entries.findIndex((entry) => entry.label === label);
  assert.ok(index >= 0, `setting ${label} must be rendered`);
  return index;
}

test('the settings screen renders every setting and masks secrets', async () => {
  const { tui } = await makeTui({ providers: { nvidia: { apiKey: 'nvapi-tui-secret-value' } } });
  const frame = tui.renderRows(90, 24).join('\n');
  assert.match(frame, /RYUU SETTINGS/);
  assert.match(frame, /DEFAULT_PROVIDER/);
  assert.match(frame, /NVIDIA_API_KEY\s+••••••••/);
  assert.ok(!frame.includes('nvapi-tui-secret-value'), 'the key must never reach the screen');
  assert.match(frame, /RYUU_PROVIDER wins over this file when set/);
});

test('arrow keys move the selection, keep it in range and scroll the window', async () => {
  const { tui } = await makeTui();
  assert.equal(tui.selected.label, 'DEFAULT_PROVIDER');
  await tui.handleKey('down');
  assert.equal(tui.selected.label, 'NVIDIA_API_KEY');
  await tui.handleKey('up');
  assert.equal(tui.selected.label, 'DEFAULT_PROVIDER');
  await tui.handleKey('up');
  assert.equal(tui.selected.label, 'DEFAULT_PROVIDER', 'the first entry stops the cursor');
  await tui.handleKey('end');
  assert.equal(tui.index, tui.entries.length - 1);
  await tui.handleKey('home');
  assert.equal(tui.index, 0);
  await tui.handleKey('pagedown');
  assert.ok(tui.index > 0);
  assert.ok(tui.offset >= 0);
  const frame = tui.renderRows(60, 14);
  assert.equal(frame.length, 14, 'a small terminal still renders a full frame');
});

test('editing a text setting saves it immediately and masks a secret afterwards', async () => {
  const { tui, file } = await makeTui();
  tui.select(numberOf(tui, 'NVIDIA_API_KEY'));
  await tui.handleKey('enter');
  tui.insertText('nvapi-tui-saved-key');
  await tui.handleKey('enter');

  assert.match(tui.status.text, /Saved NVIDIA_API_KEY/);
  const saved = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.equal(saved.providers.nvidia.apiKey, 'nvapi-tui-saved-key');
  const frame = tui.renderRows(90, 24).join('\n');
  assert.ok(!frame.includes('nvapi-tui-saved-key'), 'the saved key stays masked');
  assert.match(frame, /••••••••/);
});

test('Escape cancels an edit without writing anything', async () => {
  const { tui, file } = await makeTui();
  const before = await fsp.readFile(file, 'utf8');
  tui.select(numberOf(tui, 'NVIDIA_BASE_URL'));
  await tui.handleKey('enter');
  tui.insertText('not a url');
  await tui.handleKey('escape');
  assert.match(tui.status.text, /cancelled/);
  assert.equal(tui.editing, null);
  assert.equal(await fsp.readFile(file, 'utf8'), before);
});

test('an invalid value keeps the editor open and the file untouched', async () => {
  const { tui, file } = await makeTui();
  const before = await fsp.readFile(file, 'utf8');
  tui.select(numberOf(tui, 'MODEL[nvidia]'));
  await tui.handleKey('enter');
  tui.insertText('bad model!');
  await tui.handleKey('enter');
  assert.match(tui.status.text, /unsupported characters/);
  assert.ok(tui.editing, 'the user can fix the value instead of losing it');
  assert.equal(await fsp.readFile(file, 'utf8'), before);
});

test('left/right cycles select settings such as the provider', async () => {
  const { tui, file } = await makeTui();
  tui.select(numberOf(tui, 'DEFAULT_PROVIDER'));
  await tui.handleKey('enter');
  assert.equal(tui.editing.buffer, 'auto');
  await tui.handleKey('right');
  assert.equal(tui.editing.buffer, 'nvidia');
  await tui.handleKey('enter');
  assert.match(tui.status.text, /Saved DEFAULT_PROVIDER/);
  assert.equal(JSON.parse(await fsp.readFile(file, 'utf8')).provider, 'nvidia');
});

test('closing restores raw mode and leaves the alternate screen', async () => {
  const { tui, input, writes } = await makeTui();
  tui.enter();
  assert.equal(input.raw, true);
  assert.equal(input.listenerCount('data'), 1);
  tui.close();
  assert.equal(tui.closed, true);
  assert.equal(input.raw, false);
  assert.equal(input.listenerCount('data'), 0);
  assert.ok(writes.some((chunk) => chunk.includes('\x1b[?1049h')));
  assert.ok(writes.some((chunk) => chunk.includes('\x1b[?1049l')));
  // Idempotent: a second close must not write a second teardown.
  const count = writes.filter((chunk) => chunk.includes('\x1b[?1049l')).length;
  tui.close();
  assert.equal(writes.filter((chunk) => chunk.includes('\x1b[?1049l')).length, count);
});

test('the TUI refuses to run without an interactive terminal', async () => {
  const { tui } = await makeTui();
  tui.terminal = false;
  await assert.rejects(() => tui.run(), (error) => {
    assert.equal(error.code, 'SETTINGS_TTY_REQUIRED');
    assert.match(error.message, /interactive terminal/);
    return true;
  });
});
