import test from 'node:test';
import assert from 'node:assert/strict';
import { createUnifiedDiff, diffLines, diffStats } from '../../src/services/diff.js';

test('identical content produces no diff', () => {
  assert.equal(createUnifiedDiff('a\nb\n', 'a\nb\n'), '');
  assert.deepEqual(diffStats('same', 'same'), { added: 0, removed: 0, changed: 0 });
});

test('produces standard headers, hunks and changed lines', () => {
  const before = 'line1\nline2\nline3\nline4\nline5\n';
  const after = 'line1\nline2 changed\nline3\nline4\nline5\n';
  const diff = createUnifiedDiff(before, after, { oldLabel: 'a/file.js', newLabel: 'b/file.js' });
  assert.match(diff, /^--- a\/file\.js/m);
  assert.match(diff, /^\+\+\+ b\/file\.js/m);
  assert.match(diff, /^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
  assert.match(diff, /^-line2$/m);
  assert.match(diff, /^\+line2 changed$/m);
  assert.match(diff, /^ line1$/m);
  assert.deepEqual(diffStats(before, after), { added: 1, removed: 1, changed: 2 });
});

test('handles pure additions and deletions', () => {
  const added = createUnifiedDiff('a\n', 'a\nb\n');
  assert.match(added, /^\+b$/m);
  const removed = createUnifiedDiff('a\nb\n', 'a\n');
  assert.match(removed, /^-b$/m);
});

test('line diff marks equal, delete and add operations', () => {
  const ops = diffLines('a\nb\n', 'a\nc\n');
  assert.deepEqual(ops.map((op) => op.type), ['equal', 'del', 'add', 'equal']);
});

test('diff output is bounded by maxLines', () => {
  const before = Array.from({ length: 200 }, (_, i) => `old ${i}`).join('\n');
  const after = Array.from({ length: 200 }, (_, i) => `new ${i}`).join('\n');
  const diff = createUnifiedDiff(before, after, { maxLines: 20 });
  assert.ok(diff.split('\n').length < 60);
  assert.match(diff, /diff truncated|@@/);
});
