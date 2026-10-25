import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseToolArguments,
  repairJsonText,
  toToolArgumentsString,
  validateSchema,
} from '../../src/utils/validation.js';

test('parses well-formed tool arguments', () => {
  const parsed = parseToolArguments('{"path":"src/app.js","lines":3}');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.repaired, false);
  assert.deepEqual(parsed.value, { path: 'src/app.js', lines: 3 });
});

test('empty arguments are an empty object', () => {
  assert.deepEqual(parseToolArguments('').value, {});
  assert.deepEqual(parseToolArguments(null).value, {});
});

test('repairs a payload truncated inside an array', () => {
  const parsed = parseToolArguments('{"argv":["grep","-rn","reply(undefined)","plugins","lib",');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.repaired, true);
  assert.deepEqual(parsed.value.argv, ['grep', '-rn', 'reply(undefined)', 'plugins', 'lib']);
});

test('repairs a payload truncated inside a string', () => {
  const parsed = parseToolArguments('{"path":"src/very/long/file');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.repaired, true);
  assert.equal(parsed.value.path, 'src/very/long/file');
});

test('repairs a payload truncated after a key', () => {
  const parsed = parseToolArguments('{"path":"src/app.js","start_line":');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.repaired, true);
  assert.deepEqual(parsed.value, { path: 'src/app.js' });
});

test('repairs nested containers', () => {
  const parsed = parseToolArguments('{"a":{"b":[1,2,');
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, { a: { b: [1, 2] } });
});

test('drops a trailing comma', () => {
  const parsed = parseToolArguments('{"path":"a.js",}');
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, { path: 'a.js' });
});

test('strips a markdown fence around the payload', () => {
  const parsed = parseToolArguments('```json\n{"path":"a.js"}\n```');
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, { path: 'a.js' });
});

test('reports unrecoverable payloads instead of throwing', () => {
  const parsed = parseToolArguments('not json at all');
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /Malformed tool arguments JSON/);
});

test('rejects a non-object payload', () => {
  assert.equal(parseToolArguments('"a string"').ok, false);
  assert.equal(parseToolArguments('[1,2,3]').ok, false);
});

test('toToolArgumentsString always returns a valid JSON object', () => {
  assert.equal(toToolArgumentsString('{"path":"a.js"}'), '{"path":"a.js"}');
  assert.equal(toToolArgumentsString('{"path":"a.js'), '{"path":"a.js"}');
  assert.equal(toToolArgumentsString('garbage'), '{}');
  assert.equal(toToolArgumentsString(''), '{}');
  assert.doesNotThrow(() => JSON.parse(toToolArgumentsString('garbage')));
});

test('repairJsonText returns null when nothing can be recovered', () => {
  assert.equal(repairJsonText('}{'), null);
  assert.equal(repairJsonText(''), null);
});

test('schema validation still reports the usual errors', () => {
  const schema = {
    type: 'object',
    properties: { path: { type: 'string' }, limit: { type: 'integer' } },
    required: ['path'],
    additionalProperties: false,
  };
  assert.deepEqual(validateSchema(schema, { path: 'a.js' }), []);
  assert.match(validateSchema(schema, { limit: 1 })[0], /path: is required/);
  assert.match(validateSchema(schema, { path: 'a.js', nope: 1 })[0], /unexpected property/);
});
