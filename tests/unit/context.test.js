import test from 'node:test';
import assert from 'node:assert/strict';
import { compactMessages, conversationChars, groupMessages, summarizeFacts } from '../../src/agent/context.js';

function buildConversation(turns = 20) {
  const messages = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'Original task: fix the failing test' },
  ];
  for (let index = 0; index < turns; index += 1) {
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: `call_${index}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"src/app.js"}' } }],
    });
    messages.push({ role: 'tool', tool_call_id: `call_${index}`, content: JSON.stringify({ result: 'x'.repeat(500) }) });
  }
  return messages;
}

test('small conversations are returned unchanged', () => {
  const messages = buildConversation(2);
  const result = compactMessages(messages, { maxChars: 100000 });
  assert.equal(result.compacted, false);
  assert.equal(result.messages, messages);
});

test('large conversations are compacted while preserving task, plan and tool-call integrity', () => {
  const messages = buildConversation(30);
  const facts = {
    task: 'Original task: fix the failing test',
    plan: '1. read\n2. fix',
    changedFiles: ['src/app.js'],
    commands: [{ argv: ['npm', 'test'], status: 'exited', exitCode: 1 }],
    issues: ['test still failing'],
  };
  const result = compactMessages(messages, { maxChars: 6000, facts, recentGroups: 4 });
  assert.equal(result.compacted, true);
  assert.ok(result.removedGroups > 0);
  assert.ok(conversationChars(result.messages) < conversationChars(messages));
  assert.ok(result.messages.length < messages.length);

  const note = result.messages.find((message) => message.role === 'system' && message.content.includes('Context compacted'));
  assert.ok(note);
  assert.match(note.content, /fix the failing test/);
  assert.match(note.content, /src\/app\.js/);
  assert.match(note.content, /npm test/);

  // First user task is preserved.
  assert.ok(result.messages.some((message) => message.role === 'user' && /Original task/.test(message.content)));

  // Every tool message is immediately preceded by an assistant tool_calls message.
  for (let index = 0; index < result.messages.length; index += 1) {
    const message = result.messages[index];
    if (message.role !== 'tool') continue;
    const previous = result.messages[index - 1];
    assert.equal(previous?.role, 'assistant');
    assert.ok(Array.isArray(previous.tool_calls));
    assert.equal(previous.tool_calls[0].id, message.tool_call_id);
  }
});

test('summarizeFacts is deterministic and lists evidence', () => {
  const text = summarizeFacts({
    task: 'task',
    plan: 'plan',
    changedFiles: ['a.js', 'b.js'],
    commands: [{ argv: ['npm', 'test'], status: 'exited', exitCode: 0 }],
    issues: ['none'],
  });
  assert.match(text, /Original task: task/);
  assert.match(text, /a\.js, b\.js/);
  assert.match(text, /npm test -> exited \(exit 0\)/);
  assert.match(text, /Outstanding issues: none/);
});

test('groups an assistant tool call with all of its tool messages', () => {
  const groups = groupMessages([
    { role: 'user', content: 'hi' },
    { role: 'assistant', tool_calls: [{ id: 'a' }] },
    { role: 'tool', tool_call_id: 'a' },
    { role: 'tool', tool_call_id: 'b' },
    { role: 'assistant', content: 'done' },
  ]);
  assert.equal(groups.length, 3);
  assert.equal(groups[1].length, 3);
});
