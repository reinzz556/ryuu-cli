import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { UndoManager } from '../../src/services/undo.js';
import { createTestWorkspace } from '../helpers.js';

test('reverts a write only when the file still matches the recorded after-state', async () => {
  const fixture = await createTestWorkspace();
  try {
    const undo = new UndoManager({ workspace: fixture.workspace, dir: path.join(fixture.root, '.ryuu', 'undo') });
    undo.reset('session-a');
    await fixture.workspace.writeText('src/app.js', 'changed content\n');
    undo.record({ kind: 'write', path: 'src/app.js', before: 'export function hello(name) {\n  return `hello ${name}`;\n}\n', after: 'changed content\n' });

    await fixture.workspace.writeText('src/app.js', 'user edit\n');
    await assert.rejects(undo.revertLast(), (error) => error.code === 'FILE_CHANGED');

    await fixture.workspace.writeText('src/app.js', 'changed content\n');
    const reverted = await undo.revertLast();
    assert.equal(reverted.path, 'src/app.js');
    assert.match((await fixture.workspace.readText('src/app.js')).text, /export function hello/);
    assert.equal(undo.size, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('reverts created files by deleting them', async () => {
  const fixture = await createTestWorkspace();
  try {
    const undo = new UndoManager({ workspace: fixture.workspace });
    undo.reset('s');
    await fixture.workspace.createText('new/file.js', 'new\n');
    undo.record({ kind: 'write', path: 'new/file.js', before: null, after: 'new\n' });
    await undo.revertLast();
    assert.equal(await fixture.workspace.exists('new/file.js'), false);
  } finally {
    await fixture.cleanup();
  }
});

test('reverts deletes and moves', async () => {
  const fixture = await createTestWorkspace();
  try {
    const undo = new UndoManager({ workspace: fixture.workspace });
    undo.reset('s');

    const original = (await fixture.workspace.readText('src/util.js')).text;
    await fixture.workspace.remove('src/util.js');
    undo.record({ kind: 'delete', path: 'src/util.js', before: original });
    await undo.revertLast();
    assert.equal((await fixture.workspace.readText('src/util.js')).text, original);

    await fixture.workspace.move('src/app.js', 'src/renamed.js');
    undo.record({ kind: 'move', path: 'src/app.js', to: 'src/renamed.js' });
    await undo.revertLast();
    assert.equal(await fixture.workspace.exists('src/app.js'), true);
    assert.equal(await fixture.workspace.exists('src/renamed.js'), false);
  } finally {
    await fixture.cleanup();
  }
});

test('refuses to undo when nothing is recorded', async () => {
  const fixture = await createTestWorkspace();
  try {
    const undo = new UndoManager({ workspace: fixture.workspace });
    undo.reset('empty');
    await assert.rejects(undo.revertLast(), /Nothing to undo/);
  } finally {
    await fixture.cleanup();
  }
});
