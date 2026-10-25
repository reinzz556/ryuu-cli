import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace, isSecretPath } from '../../src/services/workspace.js';
import { createTestWorkspace, makeTempDir } from '../helpers.js';

test('read_file returns text with mtime and EOL info', async () => {
  const fixture = await createTestWorkspace();
  try {
    const file = await fixture.workspace.readText('src/app.js');
    assert.match(file.text, /export function hello/);
    assert.equal(file.eol, '\n');
    assert.ok(file.mtimeMs > 0);
    assert.equal(file.relPath, 'src/app.js');
  } finally {
    await fixture.cleanup();
  }
});

test('rejects path traversal and absolute paths outside the workspace', async () => {
  const fixture = await createTestWorkspace();
  try {
    assert.throws(() => fixture.workspace.resolve('../outside.txt'), (e) => e.code === 'PATH_ESCAPE');
    assert.throws(() => fixture.workspace.resolve('/etc/passwd'), (e) => e.code === 'PATH_ESCAPE');
    assert.throws(() => fixture.workspace.resolve('src/../../outside'), (e) => e.code === 'PATH_ESCAPE');
    await assert.rejects(fixture.workspace.readText('../package.json'), (e) => e.code === 'PATH_ESCAPE');
  } finally {
    await fixture.cleanup();
  }
});

test('rejects symlinks that escape the workspace', async () => {
  const fixture = await createTestWorkspace();
  const outside = await makeTempDir('ryuu-outside-');
  try {
    await fsp.writeFile(path.join(outside, 'secret.txt'), 'outside content');
    await fsp.symlink(path.join(outside, 'secret.txt'), path.join(fixture.root, 'escape.txt'));
    await assert.rejects(fixture.workspace.readText('escape.txt'), (e) => e.code === 'PATH_ESCAPE');

    await fsp.symlink(outside, path.join(fixture.root, 'escape-dir'));
    await assert.rejects(fixture.workspace.readText('escape-dir/secret.txt'), (e) => e.code === 'PATH_ESCAPE');

    // A symlink resolving inside the workspace is still not followed for file reads.
    const inside = path.join(fixture.root, 'src', 'app.js');
    await fsp.symlink(inside, path.join(fixture.root, 'alias.js'));
    await assert.rejects(fixture.workspace.readText('alias.js'), /symlink/i);
  } finally {
    await fixture.cleanup();
    await fsp.rm(outside, { recursive: true, force: true });
  }
});

test('secret files are blocked by default, including credential stores', async () => {
  const fixture = await createTestWorkspace({
    files: {
      '.env.local': 'NVIDIA_API_KEY=nvapi-secret\n',
      'certs/server.pem': 'PRIVATE',
      'id_rsa': 'PRIVATE',
      'src/config.ts': 'export const x = 1;\n',
    },
  });
  try {
    for (const target of ['.env', '.env.local', 'certs/server.pem', 'id_rsa', '.npmrc']) {
      assert.equal(isSecretPath(target), true, `${target} should be secret`);
      await assert.rejects(fixture.workspace.readText(target), (e) => ['SECRET_FILE_BLOCKED', 'NOT_FOUND'].includes(e.code));
    }
    assert.equal(isSecretPath('.env.example'), false);
    assert.match((await fixture.workspace.readText('.env.example')).text, /YOUR_NVIDIA_API_KEY/);
    assert.match((await fixture.workspace.readText('src/config.ts')).text, /export const x/);
  } finally {
    await fixture.cleanup();
  }
});

test('enforces file size limits and rejects binary/invalid encoding', async () => {
  const bytes = Buffer.alloc(500, 'a');
  const fixture = await createTestWorkspace({
    files: {
      'large.txt': bytes,
      'image.bin': Buffer.from([1, 0, 2, 3]),
      'invalid.txt': Buffer.from([0xff, 0xfe, 0xfd]),
    },
  });
  try {
    await assert.rejects(fixture.workspace.readText('large.txt', { maxBytes: 100 }), /too large to read/);
    await assert.rejects(fixture.workspace.readText('image.bin'), /binary/);
    await assert.rejects(fixture.workspace.readText('invalid.txt'), /not valid UTF-8/);
  } finally {
    await fixture.cleanup();
  }
});

test('readTextRange streams a range, preserves CRLF and enforces the range limits', async () => {
  const fixture = await createTestWorkspace();
  try {
    const line = 'y'.repeat(200);
    const rows = Array.from({ length: 2000 }, (_, index) => `${index + 1}:${line}`);
    await fsp.writeFile(path.join(fixture.root, 'crlf-large.txt'), rows.join('\r\n'));

    const range = await fixture.workspace.readTextRange('crlf-large.txt', {
      startLine: 1999,
      endLine: 2000,
      maxBytes: 100000,
    });
    assert.equal(range.eol, '\r\n');
    assert.equal(range.totalLines, 2000);
    assert.equal(range.startLine, 1999);
    assert.equal(range.endLine, 2000);
    assert.equal(range.text, `1999:${line}\n2000:${line}`);
    assert.equal(range.truncated, false);
    assert.equal(range.capped, false);

    const capped = await fixture.workspace.readTextRange('crlf-large.txt', {
      startLine: 1999,
      endLine: 2000,
      maxBytes: 300,
    });
    assert.equal(capped.text, `1999:${line}`);
    assert.equal(capped.endLine, 1999);
    assert.equal(capped.capped, true);
    assert.equal(capped.truncated, true);

    await assert.rejects(
      fixture.workspace.readTextRange('crlf-large.txt', { startLine: 2001 }),
      /beyond the end/,
    );
    await assert.rejects(
      fixture.workspace.readTextRange('crlf-large.txt', { startLine: 1, maxBytes: 10 }),
      /does not fit/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test('atomic writes preserve CRLF and reject stale mtime', async () => {
  const fixture = await createTestWorkspace();
  try {
    const crlf = 'line1\r\nline2\r\n';
    await fsp.writeFile(path.join(fixture.root, 'crlf.txt'), crlf);
    const before = await fixture.workspace.resolveFile('crlf.txt');
    const written = await fixture.workspace.writeText('crlf.txt', 'line1\nline2\nline3\n');
    const content = await fsp.readFile(path.join(fixture.root, 'crlf.txt'), 'utf8');
    assert.equal(content, 'line1\r\nline2\r\nline3\r\n');
    assert.equal(written.created, false);

    await assert.rejects(
      fixture.workspace.writeText('crlf.txt', 'other\n', { expectedMtimeMs: before.stat.mtimeMs - 1000 }),
      (e) => e.code === 'FILE_CHANGED',
    );
    const leftovers = (await fsp.readdir(fixture.root)).filter((name) => name.startsWith('.ryuu-tmp-'));
    assert.deepEqual(leftovers, []);
  } finally {
    await fixture.cleanup();
  }
});

test('create, move and delete are workspace-scoped', async () => {
  const fixture = await createTestWorkspace();
  try {
    const created = await fixture.workspace.createText('new/note.txt', 'hello\n');
    assert.equal(created.created, true);
    await assert.rejects(fixture.workspace.createText('new/note.txt', 'again\n'), /already exists/);

    const moved = await fixture.workspace.move('new/note.txt', 'moved/note.txt');
    assert.equal(moved.to, 'moved/note.txt');
    assert.equal((await fixture.workspace.readText('moved/note.txt')).text, 'hello\n');

    const removed = await fixture.workspace.remove('moved/note.txt');
    assert.equal(removed.kind, 'file');
    await assert.rejects(fixture.workspace.readText('moved/note.txt'), (e) => e.code === 'NOT_FOUND');
    await assert.rejects(fixture.workspace.remove('../nope'), (e) => e.code === 'PATH_ESCAPE');
  } finally {
    await fixture.cleanup();
  }
});

test('listing hides secrets and generated directories, supports filters and pagination', async () => {
  const fixture = await createTestWorkspace({ files: { 'src/deep/nested.js': 'export const n = 1;\n' } });
  try {
    const listing = await fixture.workspace.list('.', { includeHidden: true });
    const names = listing.entries.map((entry) => entry.name);
    assert.ok(names.includes('src'));
    assert.ok(names.includes('.env.example'));
    assert.ok(!names.includes('.env'));
    assert.ok(!names.includes('node_modules'));
    assert.ok(!names.includes('.git'));

    const filtered = await fixture.workspace.list('.', { filter: 'src' });
    assert.deepEqual(filtered.entries.map((entry) => entry.name), ['src']);

    const page = await fixture.workspace.list('.', { limit: 2, offset: 0, includeHidden: true });
    assert.equal(page.entries.length, 2);
    assert.equal(page.truncated, true);
    assert.equal(page.total, listing.total);
  } finally {
    await fixture.cleanup();
  }
});

test('tree is bounded and truncation is reported', async () => {
  const files = {};
  for (let i = 0; i < 30; i += 1) files[`many/file-${i}.js`] = 'x\n';
  const fixture = await createTestWorkspace({ files });
  try {
    const tree = await fixture.workspace.tree('.', { depth: 2, maxEntries: 10 });
    assert.equal(tree.truncated, true);
    assert.match(tree.text, /truncated after 10 entries/);
    assert.ok(!tree.text.includes('node_modules'));
  } finally {
    await fixture.cleanup();
  }
});

test('file_info reports metadata and blocks secrets', async () => {
  const fixture = await createTestWorkspace();
  try {
    const info = await fixture.workspace.info('src/app.js');
    assert.equal(info.kind, 'file');
    assert.ok(info.size > 0);
    assert.equal(info.isProbablyText, true);
    assert.ok(info.lines >= 3);
    await assert.rejects(fixture.workspace.info('.env'), (e) => e.code === 'SECRET_FILE_BLOCKED');
  } finally {
    await fixture.cleanup();
  }
});

test('workspace root must be an existing directory', () => {
  assert.throws(() => new Workspace('/no/such/directory-xyz'), /does not exist/);
});
