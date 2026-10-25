import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ProjectSummaryCache, SessionStore, createSessionId, createSessionRecord } from '../../src/services/sessions.js';
import { makeTempDir, writeFiles } from '../helpers.js';

async function withStore(fn) {
  const dir = await makeTempDir('ryuu-sessions-');
  const store = new SessionStore({ dir });
  try {
    await fn({ store, dir });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('saves, loads, lists and deletes sessions', async () => {
  await withStore(async ({ store, dir }) => {
    const session = createSessionRecord({ task: 'fix the bug', model: 'test/model', workspace: '/tmp/ws' });
    session.status = 'completed';
    session.steps = 3;
    session.changedFiles = ['src/app.js'];
    await store.save(session);

    const loaded = await store.load(session.id);
    assert.equal(loaded.task, 'fix the bug');
    assert.equal(loaded.status, 'completed');
    assert.equal(loaded.steps, 3);
    assert.equal(fs.statSync(path.join(dir, `${session.id}.json`)).mode & 0o777, 0o600);

    const list = await store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, session.id);
    assert.deepEqual(await store.delete(session.id), true);
    assert.deepEqual(await store.delete(session.id), false);
    assert.deepEqual(await store.list(), []);
  });
});

test('session IDs are filesystem-safe and validated', async () => {
  const id = createSessionId();
  assert.match(id, /^[A-Za-z0-9._-]+$/);
  await withStore(async ({ store }) => {
    await assert.rejects(store.load('../escape'), /Invalid session id/);
    await assert.rejects(store.load('../../etc/passwd'), /Invalid session id/);
  });
});

test('persisted sessions redact secrets and bound content', async () => {
  await withStore(async ({ store, dir }) => {
    const session = createSessionRecord({ task: 'use nvapi-secretkey123456 to call the API', model: 'm', workspace: '/w' });
    session.transcript = [
      { role: 'tool', name: 'run_command', ok: true, content: 'Authorization: Bearer abcdefghijklmnop and api_key=hunter2' },
    ];
    session.commands = [{ argv: ['echo', 'nvapi-anotherkey12345'], output: 'token=supersecret' }];
    session.issues = ['failed with nvapi-thirdkey123456'];
    // Conversation memory is persisted verbatim, so it must be redacted too.
    session.conversation = [
      { role: 'user', content: 'continue with nvapi-convsecret99999 next' },
      { role: 'assistant', content: 'Noted. token=convsupersecret22222 stays local.' },
    ];
    await store.save(session);
    const raw = await fsp.readFile(path.join(dir, `${session.id}.json`), 'utf8');
    assert.ok(!raw.includes('nvapi-secretkey123456'));
    assert.ok(!raw.includes('nvapi-anotherkey12345'));
    assert.ok(!raw.includes('nvapi-thirdkey123456'));
    assert.ok(!raw.includes('abcdefghijklmnop'));
    assert.ok(!raw.includes('hunter2'));
    assert.ok(!raw.includes('supersecret'));
    assert.ok(!raw.includes('nvapi-convsecret99999'), 'conversation tasks must be redacted');
    assert.ok(!raw.includes('convsupersecret22222'), 'conversation answers must be redacted');
    assert.match(raw, /REDACTED/);
    // The structure survives redaction so /resume can restore it.
    const parsed = JSON.parse(raw);
    assert.equal(parsed.conversation.length, 2);
    assert.equal(parsed.conversation[0].role, 'user');
    assert.equal(parsed.conversation[1].role, 'assistant');
  });
});

test('session clear removes all session files', async () => {
  await withStore(async ({ store, dir }) => {
    for (let i = 0; i < 3; i += 1) {
      await store.save(createSessionRecord({ task: `task ${i}` }));
    }
    await writeFiles(dir, { 'unrelated.txt': 'keep me' });
    const removed = await store.clear();
    assert.equal(removed, 3);
    assert.deepEqual(await store.list(), []);
    assert.ok(fs.existsSync(path.join(dir, 'unrelated.txt')));
  });
});

test('project summary cache is invalidated when manifests change', async () => {
  const root = await makeTempDir('ryuu-cache-');
  try {
    await writeFiles(root, { 'package.json': '{"name":"one"}\n' });
    const cache = new ProjectSummaryCache({ file: path.join(root, '.ryuu', 'cache', 'summary.json') });
    cache.set(root, { name: 'one' });
    assert.deepEqual(cache.get(root)?.summary, { name: 'one' });

    await fsp.writeFile(path.join(root, 'package.json'), '{"name":"two-longer"}\n');
    assert.equal(cache.get(root), null);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
