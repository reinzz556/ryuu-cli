import test from 'node:test';
import assert from 'node:assert/strict';
import { Worklog } from '../../src/agent/worklog.js';

test('records reads, changes, commands and tasks, and keeps the brief factual', () => {
  const log = new Worklog();
  log.recordRead({ path: 'src/app.js', startLine: 1, endLine: 20, totalLines: 60, mtimeMs: 1000 });
  log.recordChange({ path: 'src/app.js', tool: 'edit_file', lines: 61, mtimeMs: 2000 });
  log.recordCommand({ argv: ['npm', 'test'], exitCode: 1, durationMs: 4200 });
  log.note('search_files "hello" -> 2 match(es)');
  log.recordPlan('1. Inspect\n2. Fix');
  log.recordTask({ task: 'fix the greeting', status: 'completed', changedFiles: ['src/app.js'] });

  const brief = log.brief();
  assert.match(brief, /SESSION WORKLOG/);
  assert.match(brief, /FILES YOU ALREADY CHANGED/);
  assert.match(brief, /src\/app\.js/);
  assert.match(brief, /npm test -> exit 1/);
  assert.match(brief, /search_files "hello"/);
  assert.match(brief, /PLAN IN PROGRESS/);
  assert.match(brief, /EARLIER TASKS/);
});

test('records web searches so a later task does not pay for the same query', () => {
  const log = new Worklog();
  log.recordToolResult(
    'web_search',
    { query: 'node 25 fetch' },
    { query: 'node 25 fetch', result_count: 2, results: [{ url: 'https://nodejs.org/en/blog/25' }] },
  );
  const brief = log.brief();
  assert.match(brief, /web_search "node 25 fetch" -> 2 result\(s\)/);
  assert.match(brief, /top: https:\/\/nodejs\.org\/en\/blog\/25/);
});

test('an unchanged file is not re-read, a changed one is', () => {
  const log = new Worklog();
  log.recordRead({ path: 'src/app.js', startLine: 1, endLine: 40, totalLines: 40, mtimeMs: 1000 });

  assert.equal(log.canSkipRead('src/app.js', { startLine: 1, endLine: null, mtimeMs: 1000 }), true);
  assert.equal(log.canSkipRead('src/app.js', { startLine: 1, endLine: null, mtimeMs: 1001 }), false, 'a changed file must be re-read');
  assert.equal(log.canSkipRead('src/app.js', { startLine: 5, endLine: null, mtimeMs: 1000 }), false, 'a different range is a new read');
  assert.equal(log.canSkipRead('src/other.js', { startLine: 1, endLine: null, mtimeMs: 1000 }), false);
  assert.equal(log.canSkipRead('src/app.js', { startLine: 1, endLine: null, mtimeMs: null }), false, 'unknown mtime is never skipped');

  log.recordChange({ path: 'src/app.js', tool: 'edit_file', mtimeMs: 1001 });
  assert.equal(log.canSkipRead('src/app.js', { startLine: 1, endLine: null, mtimeMs: 1001 }), false, 'an edited file may be verified');
});

test('the worklog survives a JSON round-trip and stays bounded', () => {
  const log = new Worklog();
  for (let index = 0; index < 60; index += 1) {
    log.recordRead({ path: `src/file${index}.js`, startLine: 1, endLine: 10, totalLines: 10, mtimeMs: index });
  }
  for (let index = 0; index < 30; index += 1) {
    log.recordCommand({ argv: ['echo', String(index)], exitCode: 0, durationMs: 1 });
  }
  const restored = Worklog.fromJSON(JSON.parse(JSON.stringify(log.toJSON())));
  const brief = restored.brief({ maxChars: 4000 });
  assert.ok(brief.length <= 4000, 'the brief must respect its character budget');
  assert.ok(restored.toJSON().files.length <= 40, 'files stay bounded');
  assert.ok(restored.toJSON().commands.length <= 12, 'commands stay bounded');
  assert.ok(restored.file('src/file59.js'), 'the newest file survives the round-trip');
});

test('reset forgets every recorded fact', () => {
  const log = new Worklog();
  log.recordRead({ path: 'a.js', startLine: 1, endLine: 2, totalLines: 2, mtimeMs: 1 });
  log.recordCommand({ argv: ['npm', 'test'], exitCode: 0 });
  assert.ok(log.size > 0);
  log.reset();
  assert.equal(log.size, 0);
  assert.equal(log.brief().includes('a.js'), false);
});
