import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { Chalk } from 'chalk';
import { Renderer } from '../../src/cli/renderer.js';
import { itemRows } from '../../src/cli/tui.js';
import { toolDisplayName } from '../../src/utils/tool-display.js';

const YELLOW = '\u001b[38;2;251;191;36m';
const SKY = '\u001b[38;2;56;189;248m';
const BLUE = '\u001b[38;2;96;165;250m';

function colorStream() {
  let data = '';
  const stream = new Writable({
    write(chunk, encoding, callback) {
      data += chunk.toString();
      callback();
    },
  });
  stream.isTTY = true;
  stream.columns = 100;
  stream.rows = 40;
  stream.getColorDepth = () => 24;
  stream.getData = () => data;
  return stream;
}

test('MCP display names are namespaced and leave plugin/built-in names untouched', () => {
  const mcpPlugin = { name: 'mcp-github', mcp: true, server: 'github', displayNames: { mcp_github_search_repositories: 'search_repositories' } };
  assert.equal(toolDisplayName('mcp_github_search_repositories', mcpPlugin), 'mcp:github:search_repositories');
  assert.equal(toolDisplayName('vercel_get_project', { name: 'vercel' }), 'vercel:get_project');
  assert.equal(toolDisplayName('read_file', null), 'read_file');
});

test('renderer paints only the "mcp" prefix yellow and the rest sky blue', () => {
  const stdout = colorStream();
  const renderer = new Renderer({ stdout, stderr: stdout, color: true });
  try {
    renderer.toolStart({
      name: 'mcp_fixture_search_items',
      args: { query: 'x' },
      plugin: 'mcp-fixture',
      mcp: { server: 'fixture', tool: 'search_items' },
    });
    const out = stdout.getData();
    assert.ok(out.includes(YELLOW), 'the mcp prefix must be yellow');
    assert.ok(out.includes(SKY), 'the :server:tool part must be sky blue');
    assert.ok(out.includes(':fixture:search_items'), 'the platform/action part is shown');
    // Yellow must wrap exactly the word "mcp", not the whole label.
    assert.ok(out.includes(`${YELLOW}mcp`), 'yellow is applied to the mcp word');
    assert.equal(out.includes(`${YELLOW}:fixture`), false, 'yellow does not continue into the action');
  } finally {
    renderer.stopActivity();
  }
});

test('built-in tools keep their own colour and MCP colours do not leak in', () => {
  const stdout = colorStream();
  const renderer = new Renderer({ stdout, stderr: stdout, color: true });
  try {
    renderer.toolStart({ name: 'read_file', args: { path: 'a.txt' } });
    const out = stdout.getData();
    assert.ok(out.includes(BLUE), 'built-in tools stay blue');
    assert.ok(!out.includes(SKY), 'the MCP sky blue must not be used for built-ins');
    assert.ok(!out.includes(YELLOW), 'the MCP yellow must not be used for built-ins');
  } finally {
    renderer.stopActivity();
  }
});

test('plain output carries the MCP identity without ANSI escapes', () => {
  const stdout = colorStream();
  stdout.isTTY = false;
  const renderer = new Renderer({ stdout, stderr: stdout, plain: true });
  renderer.toolStart({
    name: 'mcp_github_create_issue',
    args: { title: 'bug' },
    plugin: 'mcp-github',
    mcp: { server: 'github', tool: 'create_issue' },
  });
  renderer.toolEnd({
    name: 'mcp_github_create_issue',
    ok: true,
    durationMs: 12,
    summary: 'created',
    plugin: 'mcp-github',
    mcp: { server: 'github', tool: 'create_issue' },
  });
  const out = stdout.getData();
  assert.match(out, /mcp:github:create_issue/);
  assert.equal(/\u001b\[/.test(out), false);
  renderer.stopActivity();
});

test('TUI transcript rows use the same yellow + sky blue identity', () => {
  const c = new Chalk({ level: 3 });
  const rows = itemRows(
    {
      kind: 'tool',
      name: 'mcp_google_drive_search_files',
      ok: true,
      plugin: 'mcp-google-drive',
      mcp: { server: 'google-drive', tool: 'search_files' },
      version: 0,
    },
    90,
    { c, color: true },
  ).join('\n');
  assert.ok(rows.includes(YELLOW));
  assert.ok(rows.includes(SKY));
  assert.ok(rows.includes(`${YELLOW}mcp`));
  assert.equal(rows.includes(`${YELLOW}:google-drive`), false);
  assert.ok(rows.includes(':google-drive:search_files'));

  const builtIn = itemRows({ kind: 'tool', name: 'read_file', ok: true, version: 0 }, 90, { c, color: true }).join('\n');
  assert.ok(!builtIn.includes(SKY), 'built-in rows must not adopt MCP colours');
});

test('the MCP status table lists state symbols and never repeats a secret', () => {
  const stdout = colorStream();
  const renderer = new Renderer({ stdout, stderr: stdout, color: true });
  renderer.mcpServers({
    title: 'MCP SERVERS',
    summary: '2 connected · 3 configured',
    rows: [
      { name: 'github', state: 'connected', symbol: '●', label: 'Connected', detail: '12 tool(s)' },
      { name: 'vercel', state: 'disabled', symbol: '⊘', label: 'Disabled', detail: '' },
    ],
  });
  const out = stdout.getData();
  assert.match(out, /MCP SERVERS/);
  assert.match(out, /2 connected · 3 configured/);
  assert.match(out, /github/);
  assert.match(out, /●/);
  assert.match(out, /vercel/);
  assert.equal(out.includes('Bearer'), false);
});
