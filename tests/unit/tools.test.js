import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ProcessManager } from '../../src/services/processes.js';
import { buildToolRegistry } from '../../src/tools/index.js';
import { createTestWorkspace } from '../helpers.js';

async function setup() {
  const fixture = await createTestWorkspace({
    files: {
      'docs/readme.md': 'Hello World from docs\nsecond line\n',
      'many/a.js': 'hello world\n',
      'many/b.js': 'nothing here\n',
      'many/c.js': 'hello world again\n',
      '.env': 'HELLO=nvapi-secret\n',
      'node_modules/dep/index.js': 'hello world in deps\n',
    },
  });
  const processes = new ProcessManager({ workspace: fixture.workspace, defaultTimeoutMs: 5000 });
  const registry = buildToolRegistry({ workspace: fixture.workspace, config: fixture.config, processes });
  const ctx = { workspace: fixture.workspace, config: fixture.config, processes };
  return {
    fixture,
    processes,
    registry,
    ctx,
    async cleanup() {
      await processes.stopAll();
      await fixture.cleanup();
    },
  };
}

test('search_files searches content and names, excluding secrets and generated dirs', async () => {
  const env = await setup();
  try {
    const content = await env.registry.execute('search_files', { query: 'hello world', target: 'content', max_results: 20 }, env.ctx);
    const files = content.result.matches.map((match) => match.file);
    assert.ok(files.includes('src/app.js') || files.includes('many/a.js'));
    assert.ok(files.includes('docs/readme.md'));
    assert.ok(!files.some((file) => file.includes('node_modules')));
    assert.ok(!files.includes('.env'));
    assert.ok(content.result.matches.every((match) => typeof match.line === 'number'));

    const names = await env.registry.execute('search_files', { query: 'app.js', target: 'name' }, env.ctx);
    assert.ok(names.result.matches.some((match) => match.file === 'src/app.js' && match.type === 'name'));

    const limited = await env.registry.execute('search_files', { query: 'hello', max_results: 1 }, env.ctx);
    assert.equal(limited.result.matches.length, 1);
    assert.equal(limited.result.truncated, true);

    await assert.rejects(
      env.registry.execute('search_files', { query: '(', regex: true }, env.ctx),
      /Invalid regular expression/,
    );
    await assert.rejects(
      env.registry.execute('search_files', { query: 'x', path: '../' }, env.ctx),
      (error) => error.code === 'PATH_ESCAPE',
    );
  } finally {
    await env.cleanup();
  }
});

test('read_file supports line ranges and reports totals', async () => {
  const env = await setup();
  try {
    const result = await env.registry.execute('read_file', { path: 'src/app.js', start_line: 2, end_line: 2 }, env.ctx);
    assert.equal(result.result.start_line, 2);
    assert.equal(result.result.end_line, 2);
    assert.match(result.result.text, /return `hello/);
    assert.ok(result.result.total_lines >= 3);
    assert.equal(result.result.truncated, true);
  } finally {
    await env.cleanup();
  }
});

test('read_file streams a line range from a file above the size limit', async () => {
  const env = await setup();
  try {
    const line = 'x'.repeat(120);
    const content = Array.from({ length: 4000 }, (_, index) => `${index + 1}:${line}`).join('\n');
    await fsp.writeFile(path.join(env.fixture.root, 'large.log'), content);
    assert.ok(content.length > env.fixture.config.maxFileBytes);

    // A full read is still refused; only the requested range is a valid ask.
    await assert.rejects(env.registry.execute('read_file', { path: 'large.log' }, env.ctx), /too large to read/);

    const range = await env.registry.execute(
      'read_file',
      { path: 'large.log', start_line: 2000, end_line: 2001 },
      env.ctx,
    );
    assert.equal(range.result.start_line, 2000);
    assert.equal(range.result.end_line, 2001);
    assert.equal(range.result.total_lines, 4000);
    assert.equal(range.result.text, `2000:${line}\n2001:${line}`);
    assert.equal(range.result.truncated, true);

    await assert.rejects(
      env.registry.execute('read_file', { path: 'large.log', start_line: 5000 }, env.ctx),
      /beyond the end/,
    );
  } finally {
    await env.cleanup();
  }
});

test('edit_file applies a unique replacement, previews a diff and refuses ambiguous matches', async () => {
  const env = await setup({});
  try {
    const preview = await env.registry.get('edit_file').preview(
      { path: 'src/app.js', old_text: 'hello ${name}', new_text: 'hi ${name}' },
      env.ctx,
    );
    assert.match(preview, /^-.*hello/m);
    assert.match(preview, /^\+.*hi/m);
    assert.match(preview, /export function hello/);

    const result = await env.registry.execute('edit_file', { path: 'src/app.js', old_text: 'hello ${name}', new_text: 'hi ${name}' }, env.ctx);
    assert.equal(result.result.occurrences, 1);
    assert.match((await env.fixture.workspace.readText('src/app.js')).text, /hi \$\{name\}/);
    await assert.rejects(
      env.registry.execute('edit_file', { path: 'src/app.js', old_text: 'not-present', new_text: 'x' }, env.ctx),
      /not found/,
    );

    await fsp.writeFile(path.join(env.fixture.root, 'dup.txt'), 'same\nsame\n');
    await assert.rejects(
      env.registry.execute('edit_file', { path: 'dup.txt', old_text: 'same', new_text: 'other' }, env.ctx),
      /matches 2 locations/,
    );
    const replaced = await env.registry.execute('edit_file', { path: 'dup.txt', old_text: 'same', new_text: 'other', replace_all: true }, env.ctx);
    assert.equal(replaced.result.occurrences, 2);
  } finally {
    await env.cleanup();
  }
});

test('write_file and create_file enforce secrets and existence rules', async () => {
  const env = await setup();
  try {
    await assert.rejects(
      env.registry.execute('write_file', { path: '.env', content: 'x' }, env.ctx),
      (error) => error.code === 'SECRET_FILE_BLOCKED',
    );
    await assert.rejects(
      env.registry.execute('create_file', { path: 'src/app.js', content: 'x' }, env.ctx),
      /already exists/,
    );
    const created = await env.registry.execute('create_file', { path: 'src/new.js', content: 'export const x = 1;\n' }, env.ctx);
    assert.equal(created.result.created, true);
    assert.equal(await env.fixture.workspace.exists('src/new.js'), true);
  } finally {
    await env.cleanup();
  }
});

test('delete_file requires confirm and diff_file does not write', async () => {
  const env = await setup();
  try {
    await assert.rejects(env.registry.execute('delete_file', { path: 'docs/readme.md' }, env.ctx), /confirm/);
    const before = (await env.fixture.workspace.readText('docs/readme.md')).text;
    const diff = await env.registry.execute('diff_file', { path: 'docs/readme.md', new_text: 'changed\n' }, env.ctx);
    assert.match(diff.result.diff, /^--- a\/docs\/readme.md/m);
    assert.equal((await env.fixture.workspace.readText('docs/readme.md')).text, before);

    const deleted = await env.registry.execute('delete_file', { path: 'docs/readme.md', confirm: true }, env.ctx);
    assert.equal(deleted.result.kind, 'file');
    assert.equal(await env.fixture.workspace.exists('docs/readme.md'), false);
  } finally {
    await env.cleanup();
  }
});

test('project_summary reads real manifests', async () => {
  const env = await setup();
  try {
    const result = await env.registry.execute('project_summary', {}, env.ctx);
    assert.equal(result.result.name, 'fixture-project');
    assert.equal(result.result.scripts.test, 'node --test');
    assert.ok(result.result.languages.JavaScript >= 1);
    assert.ok(result.result.totalFilesScanned >= 1);
    assert.equal(result.result.hasTests, true);
  } finally {
    await env.cleanup();
  }
});

test('inspect_git reports unavailable repositories without throwing', async () => {
  const env = await setup();
  try {
    const result = await env.registry.execute('inspect_git', { action: 'status' }, env.ctx);
    assert.equal(result.result.available, true);
    assert.equal(result.result.ok, false);
    assert.match(result.result.stderr, /not a git repository/i);
  } finally {
    await env.cleanup();
  }
});

test('run_command executes argv without a shell and captures results', async () => {
  const env = await setup();
  try {
    const result = await env.registry.execute(
      'run_command',
      { argv: [process.execPath, '-e', "console.log('tool-cmd-ok')"] },
      env.ctx,
    );
    assert.equal(result.result.exit_code, 0);
    assert.equal(result.result.ok, true);
    assert.match(result.result.stdout, /tool-cmd-ok/);
    await assert.rejects(
      env.registry.execute('run_command', { shell_command: 'echo hi' }, env.ctx),
      /Shell syntax is disabled/,
    );
  } finally {
    await env.cleanup();
  }
});
