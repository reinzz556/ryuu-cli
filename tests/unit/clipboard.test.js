import test from 'node:test';
import assert from 'node:assert/strict';
import { clipboardPayload, copyToClipboard } from '../../src/services/clipboard.js';

function fakeOutput({ isTTY = true } = {}) {
  const writes = [];
  return {
    isTTY,
    writes,
    write(chunk) {
      writes.push(String(chunk));
      return true;
    },
  };
}

test('the clipboard payload is an OSC 52 sequence carrying the exact text', () => {
  const payload = clipboardPayload('fix the greeting ✓');
  assert.equal(payload.chars, [...'fix the greeting ✓'].length);
  assert.ok(payload.sequence.startsWith('\x1b]52;c;'));
  assert.ok(payload.sequence.endsWith('\x1b\\'));
  const encoded = payload.sequence.slice('\x1b]52;c;'.length, -2);
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), 'fix the greeting ✓');
});

test('copyToClipboard writes to a terminal and refuses a piped stream', () => {
  const output = fakeOutput();
  const result = copyToClipboard('hello', { output });
  assert.equal(result.ok, true);
  assert.equal(result.chars, 5);
  assert.equal(output.writes.length, 1);
  assert.ok(output.writes[0].includes('\x1b]52;c;'));

  const piped = fakeOutput({ isTTY: false });
  assert.deepEqual(copyToClipboard('hello', { output: piped }), { ok: false, reason: 'no-tty', chars: 0 });
  assert.equal(piped.writes.length, 0, 'nothing is written when there is no tty');
});

test('empty text is not copied and long prompts are truncated', () => {
  assert.deepEqual(copyToClipboard('   ', { output: fakeOutput() }), { ok: false, reason: 'empty', chars: 0 });
  const payload = clipboardPayload('x'.repeat(20), { limit: 10 });
  assert.equal(payload.chars, 10);
  assert.equal(payload.truncated, true);
});
